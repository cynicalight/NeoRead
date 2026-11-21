#!/bin/sh
# Creates a self-signed certificate for local macOS signing tests.
# Squirrel.Mac requires a compatible signature: reuse the same certificate
# for both test builds and keep the key and password offline.
set -eu
out=${1:?"usage: scripts/create-mac-sign-cert.sh <new-directory>"}
if [ -e "$out" ]; then
  echo "$out already exists; refusing to overwrite a signing certificate." >&2
  exit 1
fi
openssl=/usr/bin/openssl
[ -x "$openssl" ] || openssl=openssl
umask 077
mkdir "$out"
cat >"$out/cert.cnf" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = NeoRead Self-Signed
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
EOF
"$openssl" req -x509 -newkey rsa:3072 -sha256 -days 7300 -nodes \
  -config "$out/cert.cnf" -keyout "$out/key.pem" -out "$out/cert.pem"
password=$("$openssl" rand -hex 24)
# 3DES/SHA-1 PKCS#12 keeps `security import` compatible with LibreSSL and OpenSSL 3.
"$openssl" pkcs12 -export -name "NeoRead Self-Signed" \
  -inkey "$out/key.pem" -in "$out/cert.pem" -out "$out/neoread-sign.p12" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
  -passout "pass:$password"
rm "$out/key.pem" "$out/cert.cnf"
base64 <"$out/neoread-sign.p12" | tr -d '\n' >"$out/neoread-sign.p12.base64"
printf '%s' "$password" >"$out/password.txt"
"$openssl" x509 -in "$out/cert.pem" -noout -fingerprint -sha1
cat <<EOF

Created $out. Back up neoread-sign.p12 and password.txt offline.
For local packaging, pass the base64 file contents and password via
NEOREAD_MAC_SIGN_P12 and NEOREAD_MAC_SIGN_P12_PASSWORD.
EOF
