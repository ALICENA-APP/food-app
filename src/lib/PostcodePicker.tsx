import { useEffect, useState, type FormEvent } from 'react'
import { Icon } from './icons'
import { formatPostcode, looksLikePostcode, usePostcode } from './postcode'
import { locatePostcode } from './geo'

// "Delivering to E3 2AA": tap to change. Remembered on this device.
export function PostcodePicker() {
  const [postcode, setPostcode, point] = usePostcode()

  // Postcodes saved before locations were stored get located once.
  useEffect(() => {
    if (postcode && !point) locatePostcode(postcode).then((p) => p && setPostcode(postcode, p))
  }, [postcode, point])
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(postcode)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function save(e: FormEvent) {
    e.preventDefault()
    if (value.trim() && !looksLikePostcode(value)) return setError('That doesn’t look like a UK postcode.')
    setBusy(true)
    const point = value.trim() ? await locatePostcode(value) : null
    setBusy(false)
    setPostcode(value.trim(), point)
    setError('')
    setEditing(false)
  }

  if (editing) {
    return (
      <form className="stack" style={{ gap: 6 }} onSubmit={save}>
        <div className="chat-send">
          <input autoFocus value={value} maxLength={10} onChange={(e) => setValue(e.target.value)} placeholder="Your postcode, e.g. E3 2AA" aria-label="Your postcode" autoComplete="postal-code" />
          <button type="submit" disabled={busy}>{busy ? '…' : 'Save'}</button>
        </div>
        {error && <p className="error small">{error}</p>}
      </form>
    )
  }
  return (
    <button type="button" className="location" onClick={() => { setValue(postcode); setEditing(true) }}>
      <Icon name="pin" size={18} />
      {postcode ? <>Delivering to {formatPostcode(postcode)}</> : 'East London · set your postcode'}
      <span className="muted" aria-hidden="true">▾</span>
    </button>
  )
}
