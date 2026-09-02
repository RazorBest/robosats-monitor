import copy
import json
import logging
import os
import threading
import time
from datetime import UTC, datetime

import boto3
import dotenv
import requests
import websocket
from botocore.config import Config
from websocket import WebSocketTimeoutException

from analyze import analyze

dotenv.load_dotenv()


def get_env_or_throw(name: str) -> str:
    if (value := os.getenv(name)) is None:
        raise ValueError(f"You need to set the environment variable {name}. This can also be done through the .env file.")

    return value


# S3 client pointing to Cloudflare R2
s3 = boto3.client(
    service_name="s3",
    endpoint_url=get_env_or_throw("R2_ENDPOINT_URL"),
    aws_access_key_id=get_env_or_throw("R2_ACCESS_KEY_ID"),
    aws_secret_access_key=get_env_or_throw("R2_SECRET_ACCESS_KEY"),
    region_name="auto",  # Something specific to cloudflare
    config=Config(s3={"addressing_style": "virtual"}),
)
BUCKET_NAME = get_env_or_throw("R2_BUCKET_NAME")


logger = logging.getLogger(__name__)

# Configuration
ONION_URL = "http://robosatsy56bwqn56qyadmcxkx767hnabg4mihxlmgyt6if5gnuxvzad.onion/offers"
WS_ONION_URL = "ws://ngdk7ocdzmz5kzsysa3om6du7ycj2evxp2f2olfkyq37htx3gllwp2yd.onion/relay/"
CHECK_INTERVAL = 60  # seconds between checks
LOG_DIR = "logs"
EVENTS_FILE = "data/events.log"
STATE_FILE = "data/orders_state.json"
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


def upload_df_to_s3(data, target_filename: str):
    # Upload to R2 with caching instructions
    s3.put_object(
        Bucket=BUCKET_NAME,
        Key=f"analyzed/{target_filename}",
        Body=data,
        ContentType="application/json",
        CacheControl="max-age=300",  # Tells browsers to cache for exactly 5 minutes
    )


def get_log_filename():
    """Generates a daily rotating filename: logs/onion_monitor_YYYY-MM-DD.csv"""
    date_str = datetime.now(tz=UTC).strftime("%Y-%m-%d")
    return os.path.join(LOG_DIR, f"onion_monitor_{date_str}.csv")


def read_json_from_file_or_create(path: str, default_callback=dict):
    with open(path, "a+") as file:
        file.seek(0)
        raw = file.read()
        if len(raw) == 0:
            data = default_callback()
            json.dump(data, file)
            return data
        else:
            data = json.loads(raw)
            if isinstance(data, list):
                return {eid: {"first_seen": None, "last_seen": None, "status": "unknown"} for eid in data}
            return data


class Aggregator:
    def __init__(self, events_path: str, state_path: str):
        self.events_path = events_path
        self.state_path = state_path
        self.events = {}

        self.orders_state = read_json_from_file_or_create(self.state_path)

        try:
            with open(self.events_path) as file:
                for line in file:
                    line = line.strip()
                    if not line:
                        continue
                    event = json.loads(line)
                    self.events[event["id"]] = event
        except FileNotFoundError:
            pass

    def save_state(self):
        with open(self.state_path, "w") as file:
            json.dump(self.orders_state, file, indent=2)

    def push_data(self, data: dict):
        eid = data["id"]
        order_id = next(filter(lambda l: l[0] == "d", data["tags"]))[1]
        status = next(filter(lambda l: l[0] == "s", data["tags"]))[1]

        now = int(time.time())

        # Duplicate event check: if this exact event ID was already seen
        if eid in self.events:
            if order_id in self.orders_state:
                self.orders_state[order_id]["last_seen"] = now
                self.orders_state[order_id]["status"] = status
            self.events[eid]["last_seen"] = now
            return

        # New event: preserve original first_seen if order is known
        if order_id in self.orders_state:
            first_seen = self.orders_state[order_id].get("first_seen", now)
        else:
            first_seen = now

        self.orders_state[order_id] = {
            "first_seen": first_seen,
            "last_seen": now,
            "status": status,
        }

        data = copy.deepcopy(data)
        data["first_seen"] = first_seen
        data["last_seen"] = now

        with open(self.events_path, "a") as file:
            file.write(json.dumps(data) + "\n")
            self.events[eid] = data

    def mark_missing(self, seen_order_ids: set):
        for order_id, info in self.orders_state.items():
            if info["status"] in ("success", "canceled"):
                continue
            if order_id in seen_order_ids:
                continue
            info["status"] = "missing"


def request_orders(url: str, since: int | None = None):
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
        ws = websocket.create_connection(url, timeout=30, http_proxy_host="127.0.0.1", http_proxy_port=9050, proxy_type="socks5h")
        ws.send(json.dumps(payload))
        logger.debug("WS UP - WS_CONNECTED")

        ws.settimeout(10)

        events = []

        try:
            while ret := ws.recv_data():
                _opcode, data = ret
                msg = json.loads(data)

                if msg[0] == "EVENT":
                    _mtype, _topic, data = msg
                    events.append(data)
                elif msg[0] == "EOSE":
                    break
        except WebSocketTimeoutException:
            pass

        logger.debug(f"WS events: {len(events)}")

        ws.close()
        logger.debug("WS CLOSED")

        return events[::-1]
    except Exception as e:
        logger.debug("WS DOWN")
        logger.debug(f"Exception: {e}")
        return None


def update_orders(aggregator: Aggregator, events: list):
    if not events:
        return
    seen_order_ids = set()
    for data in events:
        order_id = next(l[1] for l in data["tags"] if l[0] == "d")
        seen_order_ids.add(order_id)
        aggregator.push_data(data)
    aggregator.mark_missing(seen_order_ids)
    aggregator.save_state()


def run_robosats_monitor(ws_url: str, stop_event: threading.Event):
    # Ensure log directory exists
    os.makedirs(LOG_DIR, exist_ok=True)

    session = requests.Session()
    # Force DNS resolution through the Tor proxy
    session.proxies = {"http": "socks5h://127.0.0.1:9050", "https": "socks5h://127.0.0.1:9050"}

    logger.info(f"Starting monitor for {ws_url} via Tor...")

    # 5 days ago
    last_book_request = int(time.time()) - 5 * 24 * 60 * 60
    aggregator = Aggregator(EVENTS_FILE, STATE_FILE)

    while not stop_event.is_set():
        events = request_orders(ws_url, last_book_request)
        if events is not None:
            update_orders(aggregator, events)
            # We don't know the API, so we add a bound of 30 mins
            last_book_request = int(time.time()) - 30 * 60

        stop_event.wait(CHECK_INTERVAL)

    logger.info("Monitor runner stopped")


def run_analyzer(events_path: str, stop_event: threading.Event):
    while not stop_event.is_set():
        logger.info("Analyzer start")
        analyze(events_path, STATE_FILE)
        logger.info("Analyzer done")
        wait_seconds = 60 * 5
        stop_event.wait(timeout=wait_seconds)


def config_logging(extra_handlers: list[logging.Handler] | None = None):
    if extra_handlers is None:
        extra_handlers = []

    logging.basicConfig(
        level=logging.DEBUG,
        format="%(asctime)s [%(levelname)s] (%(threadName)s) %(name)s: %(message)s",
        handlers=[
            logging.StreamHandler(),
            *extra_handlers,
        ],
    )
    logging.getLogger("botocore").setLevel(logging.WARNING)
    logging.getLogger("urllib3").setLevel(logging.WARNING)

    logger.info("Logging data to: %s", LOGS_PATH)


def config_logging_stdout():
    logging.basicConfig(
        level=logging.DEBUG,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        handlers=[
            logging.StreamHandler(),
        ],
    )


def stopper_wrapper(stop_event: threading.Event, func, *args, **kwargs):
    try:
        return func(*args, **kwargs)
    finally:
        stop_event.set()


def main():
    config_logging(extra_handlers=[logging.FileHandler(LOGS_PATH)])

    threads = []
    stop_event = threading.Event()
    threads.append(
        threading.Thread(name="Monitor", target=stopper_wrapper, args=(stop_event, run_robosats_monitor, WS_ONION_URL, stop_event))
    )
    threads.append(threading.Thread(name="Analyzer", target=stopper_wrapper, args=(stop_event, run_analyzer, EVENTS_FILE, stop_event)))

    for t in threads:
        t.start()

    for t in threads:
        t.join()


if __name__ == "__main__":
    main()
