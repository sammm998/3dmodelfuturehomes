from __future__ import annotations

import os
from functools import lru_cache

import boto3
from botocore.config import Config


@lru_cache
def _client():
    return boto3.client(
        "s3",
        endpoint_url=os.environ.get("S3_ENDPOINT") or None,
        region_name=os.environ.get("S3_REGION", "us-east-1"),
        aws_access_key_id=os.environ.get("S3_ACCESS_KEY"),
        aws_secret_access_key=os.environ.get("S3_SECRET_KEY"),
        config=Config(
            s3={"addressing_style": "path" if os.environ.get("S3_FORCE_PATH_STYLE", "true") != "false" else "virtual"},
            signature_version="s3v4",
        ),
    )


def bucket() -> str:
    return os.environ.get("S3_BUCKET", "propertyverse")


def get(key: str) -> bytes:
    return _client().get_object(Bucket=bucket(), Key=key)["Body"].read()


def put(key: str, data: bytes, content_type: str) -> str:
    _client().put_object(Bucket=bucket(), Key=key, Body=data, ContentType=content_type)
    return key
