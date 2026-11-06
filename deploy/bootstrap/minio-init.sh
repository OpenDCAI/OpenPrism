#!/bin/sh
# Creates the app's bucket, a user limited to it and its access key on the hosted MinIO. Idempotent.
# MinIO's access key is the user name; the secret key is the user's password.
set -eu
: "${MINIO_ENDPOINT:?}" "${MINIO_ROOT_USER:?}" "${MINIO_ROOT_PASSWORD:?}" "${APP_S3_USER:?}" "${APP_S3_SECRET:?}" "${BUCKET:?}"
export MC_CONFIG_DIR="${MC_CONFIG_DIR:-/tmp/.mc}"
policy_name="openprism-${BUCKET}"
policy_file="$(mktemp)"

mc alias set root "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
mc mb --ignore-existing "root/$BUCKET"

cat > "$policy_file" <<JSON
{"Version": "2012-10-17",
 "Statement": [{"Effect": "Allow", "Action": ["s3:*"],
                "Resource": ["arn:aws:s3:::${BUCKET}", "arn:aws:s3:::${BUCKET}/*"]}]}
JSON
# "policy create" replaces an existing policy of the same name; older mc releases call it "policy add".
mc admin policy create root "$policy_name" "$policy_file" || mc admin policy add root "$policy_name" "$policy_file"

# Setting the user again just replaces its secret.
mc admin user add root "$APP_S3_USER" "$APP_S3_SECRET"
mc admin policy attach root "$policy_name" --user "$APP_S3_USER" \
  || mc admin user info root "$APP_S3_USER" | grep -q "$policy_name"
rm -f "$policy_file"
echo "minio: bucket $BUCKET and user $APP_S3_USER ready"
