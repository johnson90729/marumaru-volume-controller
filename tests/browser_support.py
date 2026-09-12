"""Shared browser protocol helper for multiplier regression tests.

Requires Chrome with CDP Extensions.loadUnpacked, Python and websocket-client.
Override CHROME_BINARY to use Chrome for Testing or another compatible Chromium.
All fixture traffic uses loopback; speaker output is disabled.
"""
import io
import json
import math
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
import urllib.request
import wave
import websocket

ROOT = Path(__file__).resolve().parents[1]
CHROME = os.environ.get('CHROME_BINARY', r'C:\Program Files\Google\Chrome\Application\chrome.exe')


class CDP:
    def __init__(self, url):
        self.ws = websocket.create_connection(url, origin='http://localhost', timeout=15)
        self.sequence = 0

    def call(self, method, session=None, **params):
        self.sequence += 1
        request = dict(id=self.sequence, method=method, params=params)
        if session:
            request['sessionId'] = session
        self.ws.send(json.dumps(request))
        while True:
            response = json.loads(self.ws.recv())
            if response.get('id') == self.sequence:
                if 'error' in response:
                    raise RuntimeError(f'{method}: {response["error"]}')
                return response.get('result', {})

    def evaluate(self, session, expression):
        result = self.call('Runtime.evaluate', session, expression=expression,
                           awaitPromise=True, returnByValue=True)
        if 'exceptionDetails' in result:
            raise RuntimeError(result['exceptionDetails'])
        return result['result'].get('value')

    def attach(self, target):
        return self.call('Target.attachToTarget', targetId=target, flatten=True)['sessionId']

