#!/usr/bin/env python3
"""Smoke test: REGISTER over SIP/WSS with digest auth, expect 200 OK.

    pip install websocket-client
    python3 infra/asterisk/scripts/wss-register-smoke.py wss://localhost:8089/ws 1001 sipkitdev123

Exit code 0 on 200 OK, 1 otherwise. Certificate verification is disabled (dev CA).
Dev/CI use only.
"""
import hashlib
import re
import ssl
import sys
import uuid

import websocket  # websocket-client


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__)
        return 2
    url, user, password = sys.argv[1:4]
    domain = "localhost"
    ws = websocket.create_connection(
        url, subprotocols=["sip"], sslopt={"cert_reqs": ssl.CERT_NONE}, timeout=10
    )
    call_id, tag = uuid.uuid4().hex, uuid.uuid4().hex[:8]

    def register(cseq: int, auth: str = "") -> str:
        ws.send(
            f"REGISTER sip:{domain} SIP/2.0\r\n"
            f"Via: SIP/2.0/WSS smoke.invalid;branch=z9hG4bK{uuid.uuid4().hex[:12]}\r\n"
            "Max-Forwards: 70\r\n"
            f"To: <sip:{user}@{domain}>\r\n"
            f"From: <sip:{user}@{domain}>;tag={tag}\r\n"
            f"Call-ID: {call_id}\r\n"
            f"CSeq: {cseq} REGISTER\r\n"
            f"Contact: <sip:{user}@smoke.invalid;transport=ws>;expires=60\r\n"
            f"{auth}Content-Length: 0\r\n\r\n"
        )
        return ws.recv()

    first = register(1)
    print("<", first.splitlines()[0])
    realm = re.search(r'realm="([^"]+)"', first)
    nonce = re.search(r'nonce="([^"]+)"', first)
    if not (realm and nonce):
        return 1
    md5 = lambda s: hashlib.md5(s.encode()).hexdigest()  # noqa: E731 (SIP digest is MD5)
    ha1 = md5(f"{user}:{realm.group(1)}:{password}")
    resp = md5(f"{ha1}:{nonce.group(1)}:{md5(f'REGISTER:sip:{domain}')}")
    auth = (
        f'Authorization: Digest username="{user}", realm="{realm.group(1)}", '
        f'nonce="{nonce.group(1)}", uri="sip:{domain}", response="{resp}", algorithm=MD5\r\n'
    )
    second = register(2, auth)
    print("<", second.splitlines()[0])
    # The contact expires after 60 s on its own (Contact ;expires=60).
    ws.close()
    return 0 if second.startswith("SIP/2.0 200") else 1


if __name__ == "__main__":
    sys.exit(main())
