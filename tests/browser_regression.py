"""Run against an isolated headless Chrome profile; no user profile is touched.

Requires Python and websocket-client. Usage: python tests/browser_regression.py
"""
import json
import base64
import io
import math
import struct
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import subprocess
import tempfile
import time
from threading import Thread
import urllib.request

import websocket

ROOT = Path(__file__).resolve().parents[1]
CHROME = Path(os.environ.get('PROGRAMFILES', 'C:/Program Files')) / 'Google/Chrome/Application/chrome.exe'


def main():
    class FixtureHandler(BaseHTTPRequestHandler):
        def handle(self):
            try:
                super().handle()
            except ConnectionResetError:
                # Chrome may close an idle HTTP socket during test teardown.
                pass

        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            self.wfile.write(b'<!doctype html><html><body></body></html>')

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), FixtureHandler)
    Thread(target=server.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix='marumaru-browser-') as profile:
        process = subprocess.Popen([
            str(CHROME), '--headless=new', '--no-first-run', '--no-default-browser-check',
            '--disable-gpu', '--remote-debugging-port=0', '--remote-allow-origins=http://localhost',
            f'--user-data-dir={profile}', 'about:blank',
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW)
        ws = None
        try:
            port_file = Path(profile) / 'DevToolsActivePort'
            for _ in range(100):
                if port_file.exists():
                    break
                time.sleep(.1)
            port = port_file.read_text().splitlines()[0]
            time.sleep(1)
            targets = json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json'))
            target = next(t for t in targets if t['type'] == 'page')
            ws = websocket.create_connection(target['webSocketDebuggerUrl'], origin='http://localhost', timeout=10)
            sequence = 0

            def cdp(method, **params):
                nonlocal sequence
                sequence += 1
                ws.send(json.dumps(dict(id=sequence, method=method, params=params)))
                while True:
                    result = json.loads(ws.recv())
                    if result.get('id') == sequence:
                        if 'error' in result:
                            raise RuntimeError(result['error'])
                        return result.get('result', {})

            def evaluate(expression, context=None):
                params = dict(expression=expression, awaitPromise=True, returnByValue=True)
                if context is not None:
                    params['contextId'] = context
                result = cdp('Runtime.evaluate', **params)
                if 'exceptionDetails' in result:
                    raise RuntimeError(result['exceptionDetails'])
                return result['result'].get('value')

            cdp('Page.enable')
            # Set a hostname without network access. Scripts run in separate MAIN
            # and ISOLATED worlds, matching the extension manifest.
            cdp('Page.navigate', url=f'http://127.0.0.1:{server.server_port}/')
            time.sleep(.3)
            frame = cdp('Page.getFrameTree')['frameTree']['frame']['id']
            cdp('Page.setDocumentContent', frameId=frame, html='''<!doctype html>
                <div id="movie_player" class="html5-video-player ytp-muted-autoplay" tabindex="0">
                  <video style="width:320px;height:180px"></video>
                  <div class="ytp-volume-panel" style="width:100px;height:30px">volume</div>
                </div><input id="search" />''')
            context = cdp('Page.createIsolatedWorld', frameId=frame, worldName='volume-test')['executionContextId']
            evaluate('''window.__saved = []; window.__listener = null;
                window.chrome = {
                  storage: {local: {get: async () => ({'siteVolume:v4:127.0.0.1': {volume: .2}}), set: async () => {}}},
                  runtime: {id: 'test', onMessage: {addListener: fn => window.__listener = fn},
                    sendMessage: async request => {
                      if (request.action === 'getTabVolume') return new Promise(resolve => window.__resolveTab = resolve);
                      if (request.action === 'saveTabVolume') window.__saved.push(request.volume);
                      return {ok:true};
                    }}
                };''', context)
            evaluate((ROOT / 'page-bridge.js').read_text(encoding='utf-8-sig'))
            evaluate((ROOT / 'content.js').read_text(encoding='utf-8-sig'), context)
            failures = []

            def check(name, expression, expected, world=None):
                actual = evaluate(expression, world)
                ok = actual == expected
                print(f'{"PASS" if ok else "FAIL"}: {name}: {actual!r}', flush=True)
                if not ok:
                    failures.append(name)

            check('default applied before background reply', 'document.querySelector("video").volume', .2)
            evaluate('window.__resolveTab({tabVolume:.3})', context)
            check('tab override wins when ready', 'document.querySelector("video").volume', .3)
            # Actual trusted input, followed by the player restoring its own value.
            cdp('Input.dispatchMouseEvent', type='mousePressed', x=50, y=50, button='left', clickCount=1)
            cdp('Input.dispatchMouseEvent', type='mouseReleased', x=50, y=50, button='left', clickCount=1)
            evaluate('document.querySelector("video").volume = .9')
            check('clicking muted autoplay video cannot overwrite volume', 'document.querySelector("video").volume', .3)
            time.sleep(.2)
            check('playback reset never saved as user preference', 'window.__saved', [], context)
            time.sleep(.4)
            # Clear a possibly contaminated old-version gesture by waiting first.
            evaluate('window.__listener({action:"setVolume",volume:.3}, {}, () => {}); window.__saved=[];', context)
            evaluate('document.querySelector("#search").focus()')
            cdp('Input.dispatchKeyEvent', type='keyDown', key='ArrowDown', code='ArrowDown', windowsVirtualKeyCode=40)
            evaluate('document.querySelector("video").volume=.8')
            check('search arrow keys do not unlock volume', 'document.querySelector("video").volume', .3)
            time.sleep(.4)
            evaluate('window.__listener({action:"setVolume",volume:.3}, {}, () => {}); window.__saved=[];', context)
            position = evaluate('(() => {const r=document.querySelector(".ytp-volume-panel").getBoundingClientRect();return {x:r.x+10,y:r.y+10}})()')
            cdp('Input.dispatchMouseEvent', type='mousePressed', button='left', clickCount=1, **position)
            evaluate('document.querySelector("video").volume=.45')
            cdp('Input.dispatchMouseEvent', type='mouseReleased', button='left', clickCount=1, **position)
            time.sleep(.2)
            check('player slider cannot overwrite extension volume', 'document.querySelector("video").volume', .3)
            check('player slider does not save a tab override', 'window.__saved', [], context)
            time.sleep(.4)
            evaluate('document.querySelector("video").replaceWith(document.createElement("video")); window.dispatchEvent(new Event("yt-navigate-finish"))')
            check('SPA replacement video inherits tab volume', 'document.querySelector("video").volume', .3)
            evaluate('document.querySelector("video").volume=1; document.querySelector("video").dispatchEvent(new Event("play"))')
            check('playback initialization retains tab volume', 'document.querySelector("video").volume', .3)
            evaluate('window.__listener({action:"setVolume",volume:0}, {}, () => {});', context)
            evaluate('document.querySelector("video").volume=1')
            check('zero volume is restored', 'document.querySelector("video").volume', 0)
            position = evaluate('(() => {const r=document.querySelector(".ytp-volume-panel").getBoundingClientRect();return {x:r.x+10,y:r.y+10}})()')
            cdp('Input.dispatchMouseEvent', type='mousePressed', button='left', clickCount=1, **position)
            evaluate('document.querySelector("video").volume=1; document.querySelector("video").muted=false')
            cdp('Input.dispatchMouseEvent', type='mouseReleased', button='left', clickCount=1, **position)
            check('extension zero beats a manual player change to 100', 'document.querySelector("video").volume', 0)
            evaluate('document.querySelector("#movie_player").focus()')
            cdp('Input.dispatchKeyEvent', type='keyDown', key='ArrowUp', code='ArrowUp', windowsVirtualKeyCode=38)
            evaluate('document.querySelector("video").volume=1')
            check('player keyboard cannot release zero volume', 'document.querySelector("video").volume', 0)
            # Bypass the MAIN setter as browser-native controls can do.
            evaluate('document.querySelector("video").volume=.0001', context)
            time.sleep(.05)
            check('native volume event restores exact zero', 'document.querySelector("video").volume', 0)
            time.sleep(.2)
            check('zero remains the saved extension setting', 'new Promise(resolve => window.__listener({action:"getSiteState"}, {}, s => resolve(s.savedVolume)))', 0, context)
            # Exercise running media with a non-silent tone; no speaker capture.
            tone = io.BytesIO()
            with wave.open(tone, 'wb') as wav:
                wav.setparams((1, 2, 8000, 0, 'NONE', 'not compressed'))
                wav.writeframes(b''.join(struct.pack('<h', int(8000 * math.sin(2 * math.pi * 440 * i / 8000))) for i in range(8000)))
            tone_url = 'data:audio/wav;base64,' + base64.b64encode(tone.getvalue()).decode('ascii')
            evaluate('''(async () => {const v=document.querySelector('video');v.loop=true;
                v.src=''' + json.dumps(tone_url) + ''';await v.play();v.volume=1;v.muted=false;})()''')
            time.sleep(.15)
            check('actively playing non-silent media retains exact zero', '(() => {const v=document.querySelector("video");return !v.paused && v.currentTime>0 && v.volume===0 && !v.muted})()', True)
            evaluate('document.querySelector("video").pause()')
            evaluate('window.__listener({action:"clearSiteVolume"}, {}, () => {});', context)
            evaluate('document.querySelector("video").volume=.7')
            check('clear preference releases volume lock', 'document.querySelector("video").volume', .7)

            # Fresh documents ensure no event listeners or gesture state leak
            # between startup races. Both storage and worker replies are delayed.
            for action in ['setVolume', 'clearSiteVolume']:
                cdp('Page.navigate', url=f'http://127.0.0.1:{server.server_port}/?race={action}')
                time.sleep(.2)
                evaluate('document.body.innerHTML = "<video></video>"')
                frame = cdp('Page.getFrameTree')['frameTree']['frame']['id']
                race_context = cdp('Page.createIsolatedWorld', frameId=frame, worldName='volume-race')['executionContextId']
                evaluate('''window.chrome = {
                    storage: {local: {get: () => new Promise(resolve => window.__resolveLocal = resolve), set: async () => {}}},
                    runtime: {id:'test', onMessage:{addListener:fn => window.__listener=fn},
                      sendMessage: async request => request.action === 'getTabVolume'
                        ? new Promise(resolve => window.__resolveTab = resolve) : {ok:true}}
                };''', race_context)
                evaluate((ROOT / 'page-bridge.js').read_text(encoding='utf-8-sig'))
                evaluate((ROOT / 'content.js').read_text(encoding='utf-8-sig'), race_context)
                evaluate('window.__listener(' + json.dumps(dict(action=action, volume=.6)) + ', {}, () => {})', race_context)
                evaluate('window.__resolveLocal({"siteVolume:v4:127.0.0.1":{volume:.2}}); window.__resolveTab({tabVolume:.3})', race_context)
                if action == 'setVolume':
                    check('late storage and worker replies cannot overwrite popup adjustment', 'document.querySelector("video").volume', .6)
                else:
                    evaluate('document.querySelector("video").volume=.7')
                    check('late initialization cannot restore a cleared preference', 'document.querySelector("video").volume', .7)
            # Exercise the actual worker's storage routing, including old bad
            # page-generated session state and independent tabs.
            evaluate('''window.__session = {'tabVolume:v4:7': {hostname:'127.0.0.1',volume:1}};
                window.chrome = {
                  storage: {
                    local: {get: async () => ({'siteVolume:v4:127.0.0.1':{volume:0}})},
                    session: {get: async key => ({[key]:window.__session[key]}),
                      set: async values => Object.assign(window.__session, values),
                      remove: async key => {delete window.__session[key]}}},
                  runtime: {onMessage:{addListener:fn => window.__worker=fn}},
                  tabs: {onRemoved:{addListener:()=>{}}}
                };''')
            evaluate((ROOT / 'background.js').read_text(encoding='utf-8-sig'))
            check('legacy player 100 cannot override stored default zero', 'new Promise(resolve => window.__worker({action:"getTabVolume",hostname:"127.0.0.1"},{tab:{id:7}}, s=>resolve(s.volume)))', 0)
            check('old page scripts cannot save player volume', 'new Promise(resolve => window.__worker({action:"saveTabVolume",hostname:"127.0.0.1",volume:1},{tab:{id:7}}, s=>resolve(s.ok)))', False)
            evaluate('new Promise(resolve => window.__worker({action:"saveTabVolume",hostname:"127.0.0.1",volume:.4,source:"extension"},{tab:{id:7}},resolve))')
            check('explicit extension change persists', 'new Promise(resolve => window.__worker({action:"getTabVolume",hostname:"127.0.0.1"},{tab:{id:7}}, s=>resolve(s.volume)))', .4)
            check('another tab keeps default zero', 'new Promise(resolve => window.__worker({action:"getTabVolume",hostname:"127.0.0.1"},{tab:{id:8}}, s=>resolve(s.volume)))', 0)

            # Actual popup initialization must not remigrate a legacy value over
            # a saved zero, and must display the policy rather than player state.
            cdp('Page.navigate', url=f'http://127.0.0.1:{server.server_port}/?popup')
            time.sleep(.2)
            import re
            html = re.sub(r'<script\b[^>]*>.*?</script>', '', (ROOT / 'popup.html').read_text(encoding='utf-8-sig'), flags=re.S)
            frame = cdp('Page.getFrameTree')['frameTree']['frame']['id']
            cdp('Page.setDocumentContent', frameId=frame, html=html)
            evaluate('''window.__local={'siteVolume:v4:127.0.0.1':{hostname:'127.0.0.1',volume:0},'127.0.0.1':.9};
                window.__messages=[];
                window.chrome={storage:{local:{get:async()=>window.__local,set:async v=>Object.assign(window.__local,v)},onChanged:{addListener:()=>{}}},
                  tabs:{query:async()=>[{id:7,url:'http://127.0.0.1/'}],sendMessage:async(id,r)=>{
                    window.__messages.push(r);return r.action==='getSiteState'?{ok:true,savedVolume:0,currentVolume:1}:{ok:true};}}};''')
            evaluate((ROOT / 'popup.js').read_text(encoding='utf-8-sig'))
            time.sleep(.05)
            check('popup opening preserves saved zero over legacy 90', 'window.__local["siteVolume:v4:127.0.0.1"].volume', 0)
            check('popup shows extension zero instead of player 100', 'document.querySelector("#volumeInput").value', '0')
            evaluate('document.querySelector("#setSiteDefault").click()')
            time.sleep(.05)
            check('saving default zero immediately applies it to current tab', 'window.__messages.at(-1).volume', 0)
            if failures:
                raise AssertionError(', '.join(failures))
        finally:
            if ws:
                ws.close()
            process.terminate()
            process.wait(timeout=10)
            server.shutdown()
            server.server_close()
            time.sleep(.3)


if __name__ == '__main__':
    main()
