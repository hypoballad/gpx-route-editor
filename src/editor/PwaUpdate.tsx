import { useEffect, useRef, useState } from 'react';

export function PwaUpdate({ hasEditing }: { hasEditing: boolean }) {
  const registration = useRef<ServiceWorkerRegistration>(undefined);
  const applying = useRef(false);
  const timeout = useRef<number>(undefined);
  const [status, setStatus] = useState<'hidden' | 'available' | 'applying' | 'retry'>('hidden');

  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
    const workers = navigator.serviceWorker;
    let controller = workers.controller;
    let lastCheck = 0;
    const events = new AbortController();
    const listening = { signal: events.signal };

    function offerUpdate() {
      if (registration.current?.waiting && workers.controller && !applying.current) {
        setStatus((current) => current === 'hidden' ? 'available' : current);
      }
    }

    function check() {
      const current = registration.current;
      if (!current || document.visibilityState !== 'visible' || Date.now() - lastCheck < 10000) return;
      lastCheck = Date.now();
      void current.update().then(offerUpdate).catch(() => { /* Keep using the current version when offline. */ });
    }

    workers.addEventListener('controllerchange', () => {
      const previous = controller;
      controller = workers.controller;
      if (!controller || !previous || controller === previous) return;
      if (applying.current) window.location.reload();
      else setStatus('available');
    }, listening);

    void workers.register(new URL('sw.js', document.baseURI), { updateViaCache: 'none' }).then((current) => {
      if (events.signal.aborted) return;
      registration.current = current;
      function watchInstall() {
        current.installing?.addEventListener('statechange', offerUpdate, listening);
      }
      current.addEventListener('updatefound', watchInstall, listening);
      watchInstall();
      offerUpdate();
      check();
    }).catch(() => { /* The editor can still run as a regular website. */ });

    const interval = window.setInterval(check, 60000);
    document.addEventListener('visibilitychange', check, listening);
    window.addEventListener('focus', check, listening);
    window.addEventListener('online', check, listening);
    return () => {
      events.abort();
      window.clearInterval(interval);
      window.clearTimeout(timeout.current);
    };
  }, []);

  function update() {
    const waiting = registration.current?.waiting;
    if (!waiting) {
      window.location.reload();
      return;
    }
    applying.current = true;
    setStatus('applying');
    waiting.postMessage('ACTIVATE_UPDATE');
    timeout.current = window.setTimeout(() => {
      applying.current = false;
      setStatus('retry');
    }, 12000);
  }

  if (status === 'hidden') return null;
  return <div className="pwa-update">
    <div role="status">
      <strong>{status === 'applying' ? '更新しています…' : '新しいバージョンがあります'}</strong>
      {status === 'retry' && <span>更新に時間がかかっています。もう一度お試しください。</span>}
      {hasEditing && status !== 'applying' && <span>再読み込みで編集中の内容が消えます。必要な場合は先にGPXを書き出してください。</span>}
    </div>
    <button type="button" onClick={update} disabled={status === 'applying'}>更新する</button>
  </div>;
}
