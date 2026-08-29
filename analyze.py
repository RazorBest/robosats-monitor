import itertools
import json
import os
import boto3
import dotenv
import pandas as pd
from botocore.config import Config

dotenv.load_dotenv()


def get_s3_client():
    endpoint = os.getenv("R2_ENDPOINT_URL")
    access_key = os.getenv("R2_ACCESS_KEY_ID")
    secret_key = os.getenv("R2_SECRET_ACCESS_KEY")
    if not (endpoint and access_key and secret_key):
        return None
    return boto3.client(
        service_name='s3',
        endpoint_url=endpoint,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        region_name="auto",
        config=Config(s3={'addressing_style': 'virtual'}),
    )


BUCKET_NAME = os.getenv("R2_BUCKET_NAME")


def upload_df_to_s3(data: str, target_filename: str):
    try:
        s3 = get_s3_client()
        if s3 and BUCKET_NAME:
            s3.put_object(
                Bucket=BUCKET_NAME,
                Key=f"analyzed/{target_filename}",
                Body=data,
                ContentType='application/json',
                CacheControl='max-age=300'
            )
    except Exception as e:
        print(f"Error uploading {target_filename} to R2: {e}")


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
    df["premium"] = pd.to_numeric(df["premium"], errors="coerce")
    df["bond"] = pd.to_numeric(df["bond"], errors="coerce")
    df["created_at"] = pd.to_datetime(df["created_at"], unit="s")
    if "done_at" in df.columns:
        df["done_at"] = pd.to_datetime(df["done_at"], unit="s", errors="coerce")
    if "first_seen" in df.columns:
        df["first_seen"] = pd.to_datetime(df["first_seen"], unit="s", errors="coerce")
    if "last_seen" in df.columns:
        df["last_seen"] = pd.to_datetime(df["last_seen"], unit="s", errors="coerce")

    df = df.sort_values(by="last_seen")
    df = df.drop_duplicates(subset=["order_id"], keep="last").copy()

    return df


def metric_average_premium(df: pd.DataFrame, currencies: list, order_types: list, group_by: list):
    df = df[(df["currency"].isin(currencies)) & (df["order_type"].isin(order_types))]
    df = df.set_index("first_seen").sort_index()

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


def store_metric(df, metric, group, currency, order_type):
    os.makedirs("public/analyzed", exist_ok=True)
            
    filename = f"{metric}_{group}_{currency}_{order_type}.json"
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


def analyze(events_path: str):
    rows = []
    print("Start reading")
    try:
        with open(events_path, "r") as file:
            for line in file.readlines():
                line = line.strip()
                if not line:
                    continue
                event = json.loads(line)
                rows.append(parse_nostr_event(event))
    except FileNotFoundError:
        return
    print("Done reading")

    if not rows:
        return

    df = pd.DataFrame(rows)
    df = preprocess(df)

    # 1. Generate full orders list and summary metadata
    print("Start storing")
    store_orders(df)
    print("Done storing")
    exit()

    # 2. Generate rolling premium metrics
    group_by_variants = ["platform", "currency", "payment_methods", "order_type"]
    currencies = set(df["currency"].dropna())
    order_types = ["buy", "sell"]

    for group_by, currency, order_type in itertools.product(group_by_variants, currencies, order_types):
        df_res = metric_average_premium(df, currencies=[currency], order_types=[order_type], group_by=group_by)
        store_metric(df_res, "rolling_premium", group_by, currency, order_type)


if __name__ == "__main__":
    # analyze("data/events.log")
    analyze("events_bishop.log")
