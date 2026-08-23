import copy
import datetime
import itertools
import json
import logging
import os
import time
from typing import Optional

import pandas as pd
import requests
import websocket
from websocket import WebSocketTimeoutException


logger = logging.getLogger(__name__)

# Configuration
ONION_URL = "http://robosatsy56bwqn56qyadmcxkx767hnabg4mihxlmgyt6if5gnuxvzad.onion/offers"
WS_ONION_URL = "ws://ngdk7ocdzmz5kzsysa3om6du7ycj2evxp2f2olfkyq37htx3gllwp2yd.onion/relay/"
CHECK_INTERVAL = 60  # seconds between checks
LOG_DIR = "logs"
EVENTS_FILE = "data/events.log"
IDS_PENDING_FILE = "data/ids_pending.json"
IDS_DONE_FILE = "data/ids_done.json"
LOGS_PATH = "logs/monitor.log"

REQUEST_PAYLOAD = [
    "REQ",
    "subscribeBook",
    {
        "authors": [
            "74001620297035daa61475c069f90b6950087fea0d0134b795fac758c34e7191",
            "f2d4855df39a7db6196666e8469a07a131cddc08dcaa744a344343ffcf54a10c",
            "95521a33ba34f5924464f425e81b896b1aa9069796a778368ed053e3612c509b",
            "ded3dc02a1a9b61ce59d11f496539cb3fd15f00326a16f47e5f8d76baba24bdb",
            "40d33962fdf26e0910805f36a3a96b239cf93b95d4a3e6dd779f1ea3ff9b0866",
            "fcc2a0bd8f5803f6dd8b201a1ddb67a4b6e268371fe7353d41d2b6684af7a61e",
            "a47457722e10ba3a271fbe7040259a3c4da2cf53bfd1e198138214d235064fc2",
            "82fa8cb978b43c79b2156585bac2c011176a21d2aead6d9f7c575c005be88390",
        ],
        "kinds": [38383],
        "since": 1787206023,
    },
] 


def get_log_filename():
    """Generates a daily rotating filename: logs/onion_monitor_YYYY-MM-DD.csv"""
    date_str = datetime.datetime.now().strftime("%Y-%m-%d")
    return os.path.join(LOG_DIR, f"onion_monitor_{date_str}.csv")


def read_json_from_file_or_create(path: str, default_callback = list):
    with open(path, "a+") as file:
        file.seek(0)
        raw = file.read()
        if len(raw) == 0:
            data = default_callback()
            json.dump(data, file)
            return data
        else:
            return json.loads(raw)


class Aggregator:
    def __init__(self, events_path: str, ids_pending_path: str, ids_done_path: str):
        self.events_path = events_path
        self.ids_pending_path = ids_pending_path
        self.ids_done_path = ids_done_path
        self.ids_done = []
        self.events = {}

        self.ids_pending = read_json_from_file_or_create(self.ids_pending_path)
        self.ids_done = read_json_from_file_or_create(self.ids_done_path)

        try:
            with open(self.events_path, "r") as file:
                for line in file.readlines():
                    event = json.loads(line)
                    self.events[event["id"]] = event
        except FileNotFoundError:
            pass

    def push_data(self, data: dict):
        eid = data["id"]

        status = list(filter(lambda l: l[0] == "s", data["tags"]))[0][1]

        if eid in self.events:
            store_copy = copy.deepcopy(self.events[eid])
            del store_copy["scrape_ts"]
            if store_copy != data:
                logger.info("Event changed")
                logger.info("Prev : %s", store_copy)
                logger.info("After: %s", data)

        data = copy.deepcopy(data)
        data["scrape_ts"] = int(time.time())

        if status == "pending" or status == "in-progress":
            if eid in self.ids_pending:
                return
            if eid in self.ids_done:
                raise ValueError("Invalid state transition state done to pending")

            self.ids_pending.append(eid)
            with open(self.ids_pending_path, "w") as file:
                json.dump(self.ids_pending, file)
        else:
            if eid in self.ids_done:
                return

            if eid in self.ids_pending:
                logger.error("Same id different values: %s", data)
                self.ids_pending.remove(eid)
                with open(self.ids_pending_path, "w") as file:
                    json.dump(self.ids_pending, file)

            self.ids_done.append(eid)
            with open(self.ids_done_path, "w") as file:
                json.dump(self.ids_done, file)

        with open(self.events_path, "a") as file:
            file.write(json.dumps(data) + "\n")
            self.events[eid] = data


def request_orders(url: str, aggregator: Aggregator, since: Optional[int] = None):
    """
    Args:
        since - UTC timestamp from when to request the orders
    """
    if since is None:
        # Two days ago
        since = int(time.time()) - 48 * 60 * 60

    payload = copy.deepcopy(REQUEST_PAYLOAD)
    payload[2]["since"] = since

    try:
        # Native SOCKS5h routing via Tor
        ws = websocket.create_connection(
            url,
            timeout=30,
            http_proxy_host="127.0.0.1",
            http_proxy_port=9050,
            proxy_type="socks5h"
        )
        ws.send(json.dumps(payload))
        logger.debug("WS UP - WS_CONNECTED")

        ws.settimeout(10)

        count = 0

        events = []

        try:
            while ret := ws.recv_data():
                opcode, data = ret
                msg = json.loads(data)

                if msg[0] == "EVENT":
                    mtype, topic, data = msg
                    events.append(data)

                    count += 1
                elif msg[0] == "EOSE":
                    break
        except WebSocketTimeoutException:
            pass

        for data in events[::-1]:
            aggregator.push_data(data)

        logger.debug(f"WS events: {count}")

        logger.debug(f"WS CLOSED")
    except Exception as e:
        logger.debug(f"WS DOWN")
        logger.debug(f"Exception: {e}")


def monitor_onion(url: str, ws_url: str):
    # Ensure log directory exists
    os.makedirs(LOG_DIR, exist_ok=True)
    
    session = requests.Session()
    # Force DNS resolution through the Tor proxy
    session.proxies = {
        'http': 'socks5h://127.0.0.1:9050',
        'https': 'socks5h://127.0.0.1:9050'
    }

    logger.info(f"Starting monitor for {url} via Tor...")

    # 5 days ago
    last_book_request = int(time.time()) - 5 * 24 * 60 * 60
    aggregator = Aggregator(EVENTS_FILE, IDS_PENDING_FILE, IDS_DONE_FILE)

    while True:
        timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        log_file = get_log_filename()
        
        # Write CSV header if this is a brand new daily file
        if not os.path.exists(log_file):
            with open(log_file, "a") as f:
                f.write("timestamp,status,details\n")

        status = "UNKNOWN"
        details = ""

        try:
            response = session.get(url, timeout=30)
            details = f"HTTP_{response.status_code}"
            
            if response.status_code == 200:
                status = "UP"
            else:
                status = "WARNING"
                
        except requests.exceptions.RequestException as e:
            status = "DOWN"
            details = type(e).__name__  # e.g., ReadTimeout, ConnectionError


        request_orders(ws_url, aggregator, last_book_request)
        # We don't know the API, so we add an error of 30 mins
        last_book_request = int(time.time()) - 30 * 60

        # Console output
        logging.info(f"[{timestamp}] {status} - {details}")

        time.sleep(CHECK_INTERVAL)


def parse_nostr_event(event):
    # Core event attributes
    row = {
        "event_id": event.get("id"),
        "created_at": event.get("created_at"),
        "pubkey": event.get("pubkey"),
        "done_at": event.get("done_at"),
    }

    # Flatten tags into columns
    for tag in event.get("tags", []):
        if not tag:
            continue
        
        key = tag[0]
        values = tag[1:]
        
        # If the tag has 1 value, store as scalar; if multiple, store as list/tuple
        if len(values) == 1:
            row[key] = values[0]
        else:
            row[key] = values

    return row


def preprocess(df: pd.DataFrame):
    # Rename nostr keys to human readable according to NIP-69: https://nips.nostr.com/69
    df = df.rename(columns={
        # NIP-69: d < Order ID >: A unique identifier for the order.
        "d": "order_id",
        # NIP-69: k < Order type >: sell or buy
        "k": "order_type",
        # NIP-69: f < Currency >: The asset being traded, using the ISO 4217 standard
        "f": "currency",
        # NIP-69: s < Status >: pending, canceled, in-progress, success, expired.
        "s": "status",
        # amt < Amount >: The amount of Bitcoin to be traded, the amount is
        #   defined in satoshis, if 0 means that the amount of satoshis
        #   will be obtained from a public API after the taker accepts
        #   the order.
        "amt": "amount",
        # NIP-69: fa < Fiat amount >: The fiat amount being traded, for range orders
        #   two values are expected, the minimum and maximum amount.
        "fa": "fiat_amount",
        # NIP-69: pm < Payment method >: The payment method used for the trade, if the
        #   order has multiple payment methods, they should be separated
        #   by a comma.
        "pm": "payment_methods",
        # NIP-69: y < Platform >: The platform that created the order.
        "y": "platform",
        # NIP-69: z < Document >: order
        "z": "document",
    })

    # Convert numeric fields to numbers
    df["premium"] = pd.to_numeric(df["premium"])
    df["bond"] = pd.to_numeric(df["bond"])
    df["created_at"] = pd.to_datetime(df["created_at"], unit="s")
    df["done_at"] = pd.to_datetime(df["done_at"], unit="s")

    return df

"""
Payment Method Risk PremiumsQuery: Calculate average markup (premium) grouped by payment_methods and type (buy vs sell).
Insight: Quantifies the "risk tax" assigned to payment rails.
Reversible or high-friction payment methods (e.g., Zelle, PayPal) command significantly higher premiums than non-reversible options (e.g., SEPA Instant, USDT, Cash in Person).
Order Completion Rate & "Ghost" LiquidityQuery: Group by order_id and track status transitions (pending $\rightarrow$ success vs pending $\rightarrow$ expired).
Insight: Measures true orderbook execution velocity versus abandoned or stale orders.
This isolates real market depth from ghost liquidity generated by inactive bots.
Cross-Platform Liquidity & Federation DominanceQuery: Count active events and sum volume bounds grouped by platform (e.g., robosats, mostro) and source onion domains.Insight: Identifies where active traders actually originate orders versus which Tor relays are simply re-broadcasting federated events across the network.Fiat Capital ConcentrationQuery: Parse fiat_amount arrays into min/max bands and bucket them into fiat tiers (e.g., $0–$100, $100–$500, $500+) by currency.Insight: Reveals market structure—whether P2P liquidity is driven by retail micro-trades or institutional-sized OTC liquidity providers.Security Bond vs. Execution QualityQuery: Measure the correlation between collateral bond percentage, premium, and completion speed.Insight: Tests whether requiring higher skin-in-the-game from traders reduces dispute/cancellation rates or allows makers to charge a premium for safety.
"""

def metric_average_premium(df: pd.DataFrame, currencies: list, order_types: list, group_by: list):
    df = df[(df["currency"].isin(currencies)) & (df["order_type"].isin(order_types))]
    # Sort by order creation
    df = df.set_index('created_at').sort_index()

    # options=["premium", "bond"]
    metric = "premium"

    # Use explode in case the row has lists
    groups = df.explode(group_by).groupby(group_by)
    df = groups.rolling("12h")
    df = (
        df[metric].agg(["mean", "median", "count"])
            .reset_index()
            .rename(columns={'premium': 'rolling_median'})
    )

    return df


def analyze(events_path: str):
    rows = []
    try:
        with open(events_path, "r") as file:
            for line in file.readlines():
                event = json.loads(line)
                rows.append(parse_nostr_event(event))
    except FileNotFoundError:
        return

    df = pd.DataFrame(rows)
    df = preprocess(df)

    group_by_variants = ["platform", "currency", "payment_methods", "order_type"]
    currencies = set(df["currency"])
    order_types = ["buy", "sell"]

    for group_by, currency, order_type in itertools.product(group_by_variants, currencies, order_types):
        df_res = metric_average_premium(df, currencies=[currency], order_types=[order_type], group_by=group_by)
        store_metric(df_res, "rolling_premium", group_by, currency, order_type)


def store_metric(df, metric, group, currency, order_type):
    os.makedirs("public/analyzed", exist_ok=True)
            
    # Save as e.g., 'public/data/platform_premium.json'
    filename = f"public/analyzed/{metric}_{group}_{currency}_{order_type}.json"
    
    # orient="records" creates a clean list of dictionaries for JS
    df.to_json(filename, orient="records", date_format="iso")


def config_logging():

    logging.basicConfig(
        level=logging.DEBUG,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        handlers=[
            logging.StreamHandler(),
            logging.FileHandler(LOGS_PATH),
        ],
    )
    logger.info("Logging data to: %s", LOGS_PATH)


def config_logging_stdout():

    logging.basicConfig(
        level=logging.DEBUG,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        handlers=[
            logging.StreamHandler(),
        ],
    )


if __name__ == "__main__":
    #config_logging()
    #monitor_onion(ONION_URL, WS_ONION_URL)

    config_logging_stdout()
    analyze(EVENTS_FILE)
