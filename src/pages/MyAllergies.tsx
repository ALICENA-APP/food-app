import { link } from '../lib/router'
import { Icon } from '../lib/icons'
import { ALLERGENS, saveMyAllergies, useMyAllergies } from '../lib/allergies'

// Allergens the person avoids. Kept on this phone only.
export default function MyAllergies() {
  const mine = useMyAllergies()
  const toggle = (code: string) =>
    saveMyAllergies({ ...mine, codes: mine.codes.includes(code) ? mine.codes.filter((c) => c !== code) : [...mine.codes, code] })

  return (
    <div className="stack">
      <a className="back" href="/profile" onClick={link('/profile')}><Icon name="back" size={18} /> Profile</a>
      <h1>My allergies</h1>
      <p className="muted">
        Choose anything you avoid. Explore can then hide dishes that contain it, and dish pages and your basket will warn you.
      </p>
      <div className="chips wrap">
        {ALLERGENS.map((a) => (
          <button key={a.code} type="button" className={`chip ${mine.codes.includes(a.code) ? 'on' : ''}`} aria-pressed={mine.codes.includes(a.code)} onClick={() => toggle(a.code)}>
            {mine.codes.includes(a.code) && <Icon name="check" size={14} />} {a.label}
          </button>
        ))}
      </div>
      <label className="check">
        <input type="checkbox" checked={mine.strict} onChange={(e) => saveMyAllergies({ ...mine, strict: e.target.checked })} />
        <span>Also hide dishes that <strong>may</strong> contain them (made near them in the kitchen)</span>
      </label>
      {mine.codes.length > 0 && (
        <button type="button" className="secondary" style={{ alignSelf: 'flex-start' }} onClick={() => saveMyAllergies({ codes: [], strict: false })}>Clear all</button>
      )}
      <div className="card stack" style={{ gap: 6 }}>
        <strong>Good to know</strong>
        <p className="small">This is saved on this phone only. BiteBY never sees it.</p>
        <p className="small">Cooks fill in the allergen details themselves, and home kitchens handle many ingredients. If your allergy is severe, message the cook before you order.</p>
        <a className="small" href="/allergens" onClick={link('/allergens')}>How allergens work on BiteBY</a>
      </div>
    </div>
  )
}
