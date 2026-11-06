"""Makes sure the app's bucket exists and that the app's S3 key pair can use it. Idempotent.

Plain S3 API through boto3 (already in the api image), configured the way every S3 client for a Garage / MinIO
style store is: an endpoint, an access key and secret key, path-style addressing and a region. It does NOT create
users or keys (that is the store's admin API, not S3), so the key pair is whatever the caller supplies.

Environment: S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET, S3_REGION (default us-east-1).
"""
import os
import sys

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

CHECK_KEY = ".openprism-bootstrap-check"


def main():
    missing = [v for v in ("S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_BUCKET") if not os.environ.get(v)]
    if missing:
        sys.exit("s3-init: missing " + ", ".join(missing))
    bucket = os.environ["S3_BUCKET"]
    s3 = boto3.client(
        "s3",
        endpoint_url=os.environ["S3_ENDPOINT"],
        aws_access_key_id=os.environ["S3_ACCESS_KEY"],
        aws_secret_access_key=os.environ["S3_SECRET_KEY"],
        region_name=os.environ.get("S3_REGION", "us-east-1"),
        config=Config(s3={"addressing_style": "path"}, signature_version="s3v4",
                      retries={"max_attempts": 3}, connect_timeout=10, read_timeout=30),
    )

    try:
        s3.head_bucket(Bucket=bucket)
        print(f"s3: bucket {bucket} already exists")
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        status = exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if code in ("404", "NoSuchBucket", "NotFound") or status == 404:
            s3.create_bucket(Bucket=bucket)
            print(f"s3: created bucket {bucket}")
        elif code in ("403", "AccessDenied", "Forbidden") or status == 403:
            sys.exit(f"s3: the key pair cannot access bucket {bucket} (403): it belongs to someone else or the key "
                     f"has no rights on it")
        else:
            raise

    # Prove the key pair can do what the app does: write, read back and delete an object.
    s3.put_object(Bucket=bucket, Key=CHECK_KEY, Body=b"ok")
    got = s3.get_object(Bucket=bucket, Key=CHECK_KEY)["Body"].read()
    s3.delete_object(Bucket=bucket, Key=CHECK_KEY)
    if got != b"ok":
        sys.exit("s3: read-back of the check object did not match")
    print(f"s3: key pair can write, read and delete in {bucket}")


if __name__ == "__main__":
    main()
