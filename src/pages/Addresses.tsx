import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { Icon } from '../lib/icons'

export type SavedAddress = { id: string; label: string | null; address: string; postcode: string }

export async function loadAddresses(): Promise<SavedAddress[]> {
  const { data } = await supabase!.from('addresses').select('id, label, address, postcode').order('created_at')
  return data ?? []
}

export async function saveAddress(a: Omit<SavedAddress, 'id'>) {
  const { error } = await supabase!.from('addresses').insert({ id: crypto.randomUUID(), ...a })
  return error?.message ?? null
}

// Saved delivery addresses, picked at checkout.
export default function Addresses() {
  const [list, setList] = useState<SavedAddress[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [label, setLabel] = useState('')
  const [address, setAddress] = useState('')
  const [postcode, setPostcode] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(() => loadAddresses().then(setList), [])
  useEffect(() => {
    load()
  }, [load])

  async function add(e: FormEvent) {
    e.preventDefault()
    setError('')
    const err = await saveAddress({ label: label.trim() || null, address: address.trim(), postcode: postcode.trim().toUpperCase() })
    if (err) return setError(err)
    setAdding(false)
    setLabel('')
    setAddress('')
    setPostcode('')
    load()
  }

  async function remove(id: string) {
    await supabase!.from('addresses').delete().eq('id', id)
    load()
  }

  if (!list) return <p className="muted">Loading…</p>
  return (
    <div className="stack">
      <h1>Addresses</h1>
      {list.length === 0 && !adding && <p className="muted">No saved addresses yet. You can also save one when you order.</p>}
      {list.map((a) => (
        <div key={a.id} className="card row-bar">
          <span className="ic-round"><Icon name="pin" /></span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <strong>{a.label || a.postcode}</strong>
            <span className="muted small story" style={{ display: 'block' }}>{a.address}{'\n'}{a.postcode}</span>
          </span>
          <button type="button" className="icon-btn" aria-label="Delete address" onClick={() => remove(a.id)}><Icon name="trash" size={18} /></button>
        </div>
      ))}
      {adding ? (
        <form className="card" onSubmit={add}>
          <label>Name (optional)<input maxLength={40} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Home, Work" /></label>
          <label>Address<textarea required rows={2} minLength={3} maxLength={300} value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="street-address" /></label>
          <label>Postcode<input required maxLength={10} value={postcode} onChange={(e) => setPostcode(e.target.value)} autoComplete="postal-code" /></label>
          <div className="row"><button type="submit">Save address</button><button type="button" className="secondary" onClick={() => setAdding(false)}>Cancel</button></div>
          {error && <p className="error small">{error}</p>}
        </form>
      ) : list.length < 5 && (
        <button type="button" className="secondary" onClick={() => setAdding(true)}><Icon name="plus" size={18} /> Add an address</button>
      )}
    </div>
  )
}
