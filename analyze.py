import json
import logging
import os
import time

import boto3
import dotenv
import pandas as pd
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


def upload_df_to_s3(data: str, target_filename: str):
    s3 = get_s3_client()
    if s3 and BUCKET_NAME:
        s3.put_object(
            Bucket=BUCKET_NAME, Key=f"analyzed/{target_filename}", Body=data, ContentType="application/json", CacheControl="max-age=300"
        )


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

    df["created_at"] = pd.to_datetime(df["order_id"].map(created_at_map))
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
    os.makedirs("public/analyzed", exist_ok=True)

    filename = f"{metric}_{group}.json"
    filepath = os.path.join("public/analyzed", filename)

    # orient="records" creates a clean list of dictionaries for JS
    json_data = df.to_json(orient="records", date_format="iso")
    with open(filepath, "w") as f:
        f.write(json_data)
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


def store_orders(df: pd.DataFrame):
    orders_json = df.to_json(date_format="iso", orient="records", indent=2)

    os.makedirs("public/analyzed", exist_ok=True)
    with open("public/analyzed/orders.json", "w") as f:
        f.write(orders_json)
    upload_df_to_s3(orders_json, "orders.json")


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

    # Generate full orders list and summary metadata
    store_orders(df)

    # Generate rolling premium metrics
    group_by_variants = ["platform", "currency", "payment_methods", "order_type"]

    for group_by in group_by_variants:
        df_res = metric_average_premium(df, group_by=group_by)
        store_metric(df_res, "rolling_premium", group_by)


if __name__ == "__main__":
    analyze("data/events.log", "data/orders_state.json")
