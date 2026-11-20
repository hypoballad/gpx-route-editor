import { useState } from 'react';

export function CopyText({ label, text }: { label: string; text: () => string }) {
  const [message, setMessage] = useState('');
  const [manual, setManual] = useState<string>();
  return <>
    <button type="button" onClick={async () => {
      const contents = text();
      try {
        await navigator.clipboard.writeText(contents);
        setManual(undefined);
        setMessage('コピーしました。');
      } catch {
        setMessage('下のテキストを選択してコピーしてください。');
        setManual(contents);
      }
    }}>{label}</button>
    <span className="copy-status" aria-live="polite">{message}</span>
    {manual !== undefined && <textarea aria-label={`${label}用のテキスト`} value={manual} readOnly rows={4}
      onFocus={(event) => event.currentTarget.select()} />}
  </>;
}
