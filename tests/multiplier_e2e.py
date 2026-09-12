"""Real v5 extension and webpage controls. No user browser profile is used."""
import base64
import io
import json
import math
from pathlib import Path
import struct
import subprocess
import tempfile
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
import urllib.request
import wave
from browser_support import CDP, CHROME

ROOT = Path(__file__).resolve().parents[1]


def main():
    checks = []

    def check(name, actual, expected):
        checks.append(dict(name=name, actual=actual, expected=expected, passed=actual == expected))
        print(json.dumps(checks[-1], ensure_ascii=True), flush=True)
        if actual != expected:
            raise AssertionError(name)

    tone = io.BytesIO()
    with wave.open(tone, 'wb') as wav:
        wav.setparams((1, 2, 8000, 0, 'NONE', 'not compressed'))
        wav.writeframes(b''.join(struct.pack('<h', int(8000 * math.sin(2 * math.pi * 440 * i / 8000))) for i in range(8000)))

    class Handler(BaseHTTPRequestHandler):
        def handle(self):
            try:
                super().handle()
            except (ConnectionResetError, BrokenPipeError):
                pass

        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Type', 'audio/wav' if self.path == '/tone.wav' else 'text/html; charset=utf-8')
            self.end_headers()
            if self.path == '/tone.wav':
                self.wfile.write(tone.getvalue())
                return
            html = '''<!doctype html><html><body><video id="normal" src="/tone.wav" loop></video>
              <input id="playerSlider" type="range" min="0" max="100" step="10" value="100">
              <script>
                window.audio=new Audio('/tone.wav');audio.loop=true;
                const host=document.createElement('div');document.body.append(host);
                const root=host.attachShadow({mode:'open'});
                root.innerHTML='<video src="/tone.wav" loop></video>';
                window.shadowVideo=root.querySelector('video');
                window.media=[document.querySelector('#normal'),audio,shadowVideo];
                window.sample=()=>media.map(m=>m.volume);
                window.playAll=()=>Promise.all(media.map(m=>m.play()));
                window.playerSlider=document.querySelector('#playerSlider');
                playerSlider.addEventListener('input',event=>{
                    window.lastInputTrusted=event.isTrusted;media[0].volume=Number(playerSlider.value)/100;
                });
                media[0].addEventListener('volumechange',()=>{
                    playerSlider.value=String(media[0].volume*100);
                    localStorage.setItem('playerVolume',String(media[0].volume));
                });
                window.playPromise=playAll();
              </script>'''
            if not self.path.startswith('/child'):
                html += f'<iframe src="http://localhost:{self.server.server_port}/child"></iframe>'
            self.wfile.write((html + '</body></html>').encode())

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    Thread(target=server.serve_forever, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix='marumaru-v5-e2e-') as profile:
        process = subprocess.Popen([
            CHROME, '--headless=new', '--no-first-run', '--no-default-browser-check',
            '--disable-gpu', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
            '--enable-unsafe-extension-debugging', '--remote-debugging-port=0',
            '--remote-allow-origins=http://localhost', f'--user-data-dir={profile}', 'about:blank'
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        client = None
        try:
            port_file = Path(profile) / 'DevToolsActivePort'
            for _ in range(100):
                if port_file.exists(): break
                time.sleep(.1)
            port = port_file.read_text().splitlines()[0]
            for _ in range(50):
                try:
                    version = json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json/version', timeout=2))
                    break
                except OSError: time.sleep(.1)
            client = CDP(version['webSocketDebuggerUrl'])
            print(json.dumps({'browser': version['Browser']}), flush=True)
            extension = client.call('Extensions.loadUnpacked', path=str(ROOT))['id']
            worker = None
            for _ in range(50):
                worker = next((t for t in client.call('Target.getTargets')['targetInfos']
                               if t['type'] == 'service_worker' and extension in t['url']), None)
                if worker: break
                time.sleep(.1)
            worker_session = client.attach(worker['targetId'])

            def worker_eval(expression):
                return client.evaluate(worker_session, expression)

            for _ in range(50):
                if worker_eval("typeof chrome !== 'undefined' && !!chrome.storage"): break
                time.sleep(.1)
            worker_eval("chrome.storage.local.set({'siteGain:v5:127.0.0.1':{hostname:'127.0.0.1',gain:.2},'siteVolume:v4:127.0.0.1':{volume:0},'127.0.0.1':.9})")
            url = f'http://127.0.0.1:{server.server_port}/'
            target = client.call('Target.createTarget', url=url)['targetId']
            page = client.attach(target)
            time.sleep(.5)

            def physical(session):
                # Read actual native volume in an isolated world, never the v5 logical getter.
                frame = client.call('Page.getFrameTree', session)['frameTree']['frame']['id']
                context = client.call('Page.createIsolatedWorld', session, frameId=frame, worldName='native-volume-check')['executionContextId']
                values = []
                for index in range(3):
                    result = client.call('Runtime.evaluate', session, expression=f'media[{index}]')
                    node = client.call('DOM.describeNode', session, objectId=result['result']['objectId'])['node']['backendNodeId']
                    obj = client.call('DOM.resolveNode', session, backendNodeId=node, executionContextId=context)['object']['objectId']
                    raw = client.call('Runtime.callFunctionOn', session, objectId=obj,
                                      functionDeclaration='function(){return this.volume}', returnByValue=True)['result']['value']
                    values.append(round(raw, 8))
                    client.call('Runtime.releaseObject', session, objectId=obj)
                    client.call('Runtime.releaseObject', session, objectId=result['result']['objectId'])
                return values

            def set_factor(value):
                worker_eval("chrome.storage.local.set({'siteGain:v5:127.0.0.1':{hostname:'127.0.0.1',gain:" + str(value) + "}})")
                time.sleep(.1)

            check('page sees full original player volume', client.evaluate(page, 'sample()'), [1, 1, 1])
            check('normal/detached/open-shadow output is multiplied', physical(page), [.2, .2, .2])
            check('all media are actually playing', client.evaluate(page, 'media.every(m=>!m.paused&&m.currentTime>0)'), True)
            child = next(t for t in client.call('Target.getTargets')['targetInfos'] if t['type']=='iframe' and '/child' in t['url'])
            child_page = client.attach(child['targetId'])
            check('cross-origin iframe uses top-level site factor', physical(child_page), [.2, .2, .2])

            # Trusted keyboard input on a webpage slider with normal volumechange feedback.
            client.evaluate(page, 'playerSlider.focus()')
            for _ in range(5):
                client.call('Input.dispatchKeyEvent', page, type='keyDown', key='ArrowLeft', code='ArrowLeft', windowsVirtualKeyCode=37)
                client.call('Input.dispatchKeyEvent', page, type='keyUp', key='ArrowLeft', code='ArrowLeft', windowsVirtualKeyCode=37)
            time.sleep(.1)
            check('web slider receives real user input', client.evaluate(page, 'lastInputTrusted'), True)
            check('web slider stays at 50 instead of snapping to effective 10', client.evaluate(page, 'playerSlider.value'), '50')
            check('50% player times 20% site equals 10% output', physical(page), [.1, .2, .2])
            check('page saves its logical volume, not attenuated output', client.evaluate(page, "localStorage.getItem('playerVolume')"), '0.5')
            client.evaluate(page, 'for(let i=0;i<10;i++)media[0].volume=media[0].volume')
            check('read/write feedback does not repeatedly attenuate', physical(page), [.1, .2, .2])
            check('player changes never overwrite saved site factor', worker_eval("chrome.storage.local.get('siteGain:v5:127.0.0.1').then(v=>v['siteGain:v5:127.0.0.1'].gain)"), .2)

            # Actual extension action and popup APIs.
            action_target = next(t for t in client.call('Target.getTargets', filter=[{'type':'tab'}])['targetInfos'] if t['url']==url)
            client.call('Extensions.triggerAction', id=extension, targetId=action_target['targetId'])
            popup_target = None
            for _ in range(30):
                popup_target = next((t for t in client.call('Target.getTargets')['targetInfos'] if t['url']==f'chrome-extension://{extension}/popup.html'), None)
                if popup_target: break
                time.sleep(.1)
            popup = client.attach(popup_target['targetId'])
            for _ in range(40):
                if client.evaluate(popup, "document.querySelector('#outputReadout')?.textContent==='10%'"): break
                time.sleep(.1)
            check('popup separates player/factor/output', client.evaluate(popup, "['playerReadout','factorReadout','outputReadout'].map(id=>document.getElementById(id).textContent)"), ['50%', '20%', '10%'])
            shot = client.call('Page.captureScreenshot', popup, format='png')['data']
            (ROOT/'tests'/'popup-preview.png').write_bytes(base64.b64decode(shot))

            def popup_factor(value):
                client.evaluate(popup, f"document.querySelector('#factorInput').value='{value}';document.querySelector('#factorInput').dispatchEvent(new Event('input',{{bubbles:true}}))")
                time.sleep(.2)

            popup_factor(40)
            check('popup auto-saves site factor', worker_eval("chrome.storage.local.get('siteGain:v5:127.0.0.1').then(v=>v['siteGain:v5:127.0.0.1'].gain)"), .4)
            check('factor change preserves player position', client.evaluate(page, 'sample()'), [.5, 1, 1])
            check('factor change scales existing media once', physical(page), [.2, .4, .4])
            check('factor change updates cross-origin frame', physical(child_page), [.4, .4, .4])

            popup_factor(0)
            client.evaluate(page, 'media[0].volume=1;media[0].muted=false')
            check('site zero stays silent when player goes to 100', physical(page), [0, 0, 0])
            check('player position still works under zero factor', client.evaluate(page, 'playerSlider.value'), '100')
            popup_factor(20)
            check('leaving zero restores current player positions', physical(page), [.2, .2, .2])
            client.evaluate(page, 'media[0].volume=.5;media[0].muted=true;audio.pause();shadowVideo.pause()')
            client.evaluate(child_page, 'media.forEach(m=>m.pause())')
            time.sleep(.7)
            check('popup accounts for player mute', client.evaluate(popup, "document.querySelector('#outputReadout').textContent"), '0%')
            client.evaluate(page, 'media[0].muted=false')
            check('unmute preserves multiplier and player setting', physical(page), [.1, .2, .2])

            # Fault injection in the disposable worker; extension code remains unchanged.
            worker_eval("globalThis.realSet=chrome.storage.local.set;chrome.storage.local.set=async()=>{throw new Error('injected storage failure')}")
            popup_factor(30)
            check('failed save is shown, not reported as saved', client.evaluate(popup, "document.querySelector('#status').textContent.includes('\u5132\u5b58\u5931\u6557')"), True)
            check('failed save leaves actual factor unchanged', physical(page), [.1, .2, .2])
            worker_eval('chrome.storage.local.set=globalThis.realSet')
            popup_factor(20)

            client.call('Page.reload', page)
            time.sleep(.4)
            check('site factor survives reload', physical(page), [.2, .2, .2])
            check('new player is not forced to extension percent on its slider', client.evaluate(page, 'playerSlider.value'), '100')
            # Popup might close on navigation; close any previous action before reopening.
            for t in client.call('Target.getTargets')['targetInfos']:
                if t['url']==f'chrome-extension://{extension}/popup.html': client.call('Target.closeTarget', targetId=t['targetId'])
            another = client.call('Target.createTarget', url=url)['targetId']
            another_page = client.attach(another)
            time.sleep(.4)
            client.evaluate(another_page, 'media[0].volume=.3')
            check('another tab shares factor but has independent player volume', physical(another_page), [.06, .2, .2])
            check('first tab player remains independent', physical(page), [.2, .2, .2])
            set_factor(.5)
            check('saved factor updates already-open tabs', physical(another_page), [.15, .5, .5])
            check('saved factor updates first tab without changing player volume', physical(page), [.5, .5, .5])
            client.call('Target.closeTarget', targetId=another)
            client.call('Target.activateTarget', targetId=target)
            worker_eval("chrome.storage.local.remove('siteGain:v5:127.0.0.1')")
            time.sleep(.1)
            check('removing factor restores original output', physical(page), [1, 1, 1])
            client.call('Page.reload', page)
            time.sleep(.4)
            check('v4 fixed-volume data is never reinterpreted or resurrected', physical(page), [1, 1, 1])
            check('old settings are left intact', worker_eval("chrome.storage.local.get('siteVolume:v4:127.0.0.1').then(v=>v['siteVolume:v4:127.0.0.1'].volume)"), 0)
            check('native invalid volume error preserved', client.evaluate(page, "(()=>{try{audio.volume=2;return null}catch(e){return e.name}})()"), 'IndexSizeError')

            (ROOT/'tests'/'test-results.json').write_text(json.dumps(checks,ensure_ascii=False,indent=2),encoding='utf-8')
            print(f'{len(checks)} multiplier checks passed', flush=True)
        finally:
            if client: client.ws.close()
            process.terminate()
            process.wait(timeout=10)
            server.shutdown()
            server.server_close()
            time.sleep(.3)


if __name__ == '__main__':
    main()
