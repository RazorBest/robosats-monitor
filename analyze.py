import json
import logging
import os
import time
from datetime import UTC, datetime

import boto3
import dotenv
import pandas as pd
import requests
from botocore.config import Config

dotenv.load_dotenv()


logger = logging.getLogger(__name__)


def get_s3_client():
    endpoint = os.getenv("R2_ENDPOINT_URL")
    access_key = os.getenv("R2_ACCESS_KEY_ID")
    secret_key = os.getenv("R2_SECRET_ACCESS_KEY")
    if not (endpoint and access_key and secret_key):
        return None
    return boto3.client(
        service_name="s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
        config=Config(s3={"addressing_style": "virtual"}),
    )


BUCKET_NAME = os.getenv("R2_BUCKET_NAME")
ANALYZED_DIR = "public/analyzed"


def upload_df_to_s3(data: str, target_filename: str, cache_control: str | None = None):
    s3 = get_s3_client()
    if not (s3 and BUCKET_NAME):
        return

    if cache_control is None:
        cache_control = "max-age=300"

    s3.put_object(
        Bucket=BUCKET_NAME, Key=f"analyzed/{target_filename}", Body=data, ContentType="application/json", CacheControl=cache_control
    )


def write_df_locally(data: str, target_filename: str):
    os.makedirs(ANALYZED_DIR, exist_ok=True)
    filepath = os.path.join(ANALYZED_DIR, target_filename)
    with open(filepath, "w") as f:
        f.write(data)


def parse_nostr_event(event):
    # Core event attributes
    row = {
        "event_id": event.get("id"),
        "created_at": event.get("created_at"),
        "first_seen": event.get("first_seen"),
        "last_seen": event.get("last_seen"),
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


def preprocess(df: pd.DataFrame, orders_state: dict):
    # Rename nostr keys to human readable according to NIP-69: https://nips.nostr.com/69
    df = df.rename(
        columns={
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
        }
    )

    # Convert numeric fields to numbers
    df["premium"] = pd.to_numeric(df["premium"], errors="coerce")
    df["bond"] = pd.to_numeric(df["bond"], errors="coerce")
    df["created_at"] = pd.to_datetime(df["created_at"], unit="s", errors="coerce")
    if "done_at" in df.columns:
        df["done_at"] = pd.to_datetime(df["done_at"], unit="s", errors="coerce")
    if "first_seen" in df.columns:
        df["first_seen"] = pd.to_datetime(df["first_seen"], unit="s", errors="coerce")
    if "last_seen" in df.columns:
        df["last_seen"] = pd.to_datetime(df["last_seen"], unit="s", errors="coerce")

    df["order_id"] = df["order_id"].apply(lambda x: x[0] if isinstance(x, list) and len(x) > 0 else (str(x) if isinstance(x, list) else x))

    created_at_map = df.loc[df["status"] == "pending"].groupby("order_id")["created_at"].min().to_dict()
    success_ts_map = df.loc[df["status"] == "success"].groupby("order_id")["created_at"].max().to_dict()

    df = df.sort_values(by="last_seen")
    df = df.drop_duplicates(subset=["order_id"], keep="last").copy()

    df["created_at"] = pd.to_datetime(df["order_id"].map(created_at_map)).fillna(df["created_at"])
    df["success_ts"] = pd.to_datetime(df["order_id"].map(success_ts_map))

    df["last_seen"] = pd.to_datetime(df["order_id"].map(lambda oid: orders_state[oid]["last_seen"]), unit="s")
    df["status"] = df["order_id"].map(lambda oid: orders_state[oid]["status"])

    # Expiration tag can have duration as a second element: ["expiration", "<timestamp>", "<duration_seconds>"].
    # Extract the first element (the unix timestamp) if present as a list.
    if "expiration" in df.columns:
        df["expiration"] = df["expiration"].apply(lambda x: x[0] if isinstance(x, (list, tuple)) and len(x) > 0 else x)
        df["expiration"] = pd.to_numeric(df["expiration"], errors="coerce")

    # Status is tracked by monitor.py. Terminal statuses ('success', 'canceled') never expire.
    # If an active or missing order passed its expiration time since the last monitor poll, mark it as expired.
    now = int(time.time())
    is_active = ~df["status"].isin(["success", "canceled"])
    is_expired = is_active & df["expiration"].notna() & (now > df["expiration"])
    df.loc[is_expired, "status"] = "expired"

    return df


def metric_average_premium(df: pd.DataFrame, group_by: str):
    groupby_cols = list(dict.fromkeys([group_by, "platform", "currency", "order_type"]))

    # Use explode in case the row has lists (e.g. payment_methods)
    df_exploded = df.explode(group_by).copy()

    # Ensure all groupby columns contain hashable scalars before grouping
    for col in groupby_cols:
        if col in df_exploded.columns:
            df_exploded[col] = df_exploded[col].apply(lambda x: ", ".join(str(i) for i in x) if isinstance(x, list) else x)

    df_clean = df_exploded.dropna(subset=["first_seen", "premium"] + groupby_cols)
    df_indexed = df_clean.set_index("first_seen").sort_index()

    metric = "premium"
    groups = df_indexed.groupby(groupby_cols)
    df_res = groups.rolling("12h")[metric].agg(["mean", "median", "count"]).reset_index()

    return df_res


def store_metric(df, metric, group):
    filename = f"{metric}_{group}.json"
    # orient="records" creates a clean list of dictionaries for JS
    json_data = df.to_json(orient="records", date_format="iso")
    write_df_locally(json_data, filename)
    upload_df_to_s3(json_data, filename)


def format_payment_methods(pm):
    if isinstance(pm, list):
        return ", ".join(str(x) for x in pm)
    return str(pm) if pd.notnull(pm) else "--"


def format_platform(p):
    if isinstance(p, list):
        return " / ".join(str(x) for x in p)
    return str(p) if pd.notnull(p) else "--"


def format_fiat_amount(fa):
    if isinstance(fa, list):
        if len(fa) == 2:
            try:
                return f"{float(fa[0]):,.2f} - {float(fa[1]):,.2f}"
            except (ValueError, TypeError):
                return f"{fa[0]} - {fa[1]}"
        return ", ".join(str(x) for x in fa)
    if isinstance(fa, (int, float, str)) and fa != "":
        try:
            return f"{float(fa):,.2f}"
        except (ValueError, TypeError):
            return str(fa)
    return "--"


_spot_cache: dict[tuple[str, str | None], float | None] = {}


def fetch_btc_spot_rate(currency: str, date_str: str | None = None) -> float | None:
    cache_key = (currency, date_str)
    if cache_key in _spot_cache:
        return _spot_cache[cache_key]

    if currency in ("BTC", "L-BTC"):
        return 1.0

    url = f"https://api.coinbase.com/v2/prices/BTC-{currency}/spot"

    try:
        response = requests.get(url, params={"date": date_str}, timeout=10)
        if response.status_code == 200:
            rate = float(response.json()["data"]["amount"])
            _spot_cache[cache_key] = rate
            return rate
    except (requests.RequestException, KeyError, ValueError) as e:
        logger.debug("Failed to fetch spot rate for %s (%s): %s", currency, date_str, e)

    _spot_cache[cache_key] = None
    return None


def calculate_order_sats(fiat_amount: float | list, premium: float, rate: float) -> int | None:
    if rate <= 0:
        return None

    try:
        # Choose minimum if range
        fiat = float(fiat_amount[0] if isinstance(fiat_amount, list) else fiat_amount)
    except (ValueError, TypeError, IndexError):
        return None

    try:
        prem = float(premium)
    except (ValueError, TypeError):
        prem = 0.0

    factor = 1.0 + (prem / 100.0)
    if factor <= 0:
        return None

    sats = (fiat / (rate * factor)) * 1e8
    return round(sats)


def enrich_orders_with_sats(df: pd.DataFrame) -> pd.DataFrame:
    sats_list: list[int | None] = []

    for _, row in df.iterrows():
        raw_amt = pd.to_numeric(row.get("amount"), errors="coerce")
        if pd.notna(raw_amt) and raw_amt > 0:
            sats_list.append(int(raw_amt))
            continue

        date_str = None
        if pd.notna(row.get("created_at")):
            date_str = row["created_at"].strftime("%Y-%m-%d")
        elif pd.notna(row.get("first_seen")):
            date_str = row["first_seen"].strftime("%Y-%m-%d")

        spot_rate = fetch_btc_spot_rate(row["currency"], date_str)
        sats = None
        if spot_rate is not None:
            sats = calculate_order_sats(row["fiat_amount"], row["premium"], spot_rate)
        sats_list.append(sats)

    df["amount_sats"] = pd.Series(sats_list, index=df.index, dtype="Int64")
    return df


def store_orders(df: pd.DataFrame):
    orders_json = df.to_json(date_format="iso", orient="records", indent=2)
    write_df_locally(orders_json, "orders.json")
    upload_df_to_s3(orders_json, "orders.json")


def store_last_alive():
    now_iso = datetime.now(tz=UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    alive_json = json.dumps({"last_alive": now_iso}, indent=2) + "\n"
    write_df_locally(alive_json, "last_alive.json")
    upload_df_to_s3(alive_json, "last_alive.json", cache_control="max-age=60")


def analyze(events_path: str, state_path: str):
    rows = []
    try:
        with open(events_path) as file:
            for line in file:
                line = line.strip()
                if not line:
                    continue
                event = json.loads(line)
                rows.append(parse_nostr_event(event))
    except FileNotFoundError:
        logger.debug("Events file still not present: %s", events_path)
        return

    if not rows:
        return

    with open(state_path) as file:
        orders_state = json.load(file)

    df = pd.DataFrame(rows)
    df = preprocess(df, orders_state)
    # TODO: remove me
    print(f"Count: {len(df)}")

    df = enrich_orders_with_sats(df)

    # Generate full orders list and summary metadata
    store_orders(df)

    # Generate rolling premium metrics
    group_by_variants = ["platform", "currency", "payment_methods", "order_type"]

    for group_by in group_by_variants:
        df_res = metric_average_premium(df, group_by=group_by)
        store_metric(df_res, "rolling_premium", group_by)

    store_last_alive()


if __name__ == "__main__":
    analyze("data/events.log", "data/orders_state.json")
