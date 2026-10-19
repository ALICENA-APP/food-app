import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from './supabase'
import { downloadCsv, money } from './csv'

// Tax details HMRC asks marketplaces to report each January (the reporting
// rules for digital platforms). Only the cook and BiteBY admins can see them.

type TaxDetails = {
  seller_account_id: string
  date_of_birth: string | null
  tax_id_kind: 'nino' | 'utr' | 'company'
  tax_id: string
  company_number: string | null
  address_line1: string
  address_line2: string | null
  city: string
  postcode: string
}

const KIND_LABEL: Record<TaxDetails['tax_id_kind'], string> = {
  nino: 'National Insurance number',
  utr: 'UTR (Unique Taxpayer Reference)',
  company: 'Company number',
}

function useTaxDetails(accountId: string) {
  const [details, setDetails] = useState<TaxDetails | null | undefined>(undefined)
  const [due, setDue] = useState<string | null>(null)
  const load = useCallback(async () => {
    const db = supabase!
    const [t, a] = await Promise.all([
      db.from('seller_tax_details').select('*').eq('seller_account_id', accountId).maybeSingle(),
      db.from('seller_accounts').select('tax_details_due').eq('id', accountId).maybeSingle(),
    ])
    setDetails((t.data as TaxDetails | null) ?? null)
    setDue(a.data?.tax_details_due ?? null)
  }, [accountId])
  useEffect(() => {
    load()
  }, [load])
  return { details, due, load }
}

const masked = (t: TaxDetails) => `${KIND_LABEL[t.tax_id_kind]} ending ${t.tax_id.slice(-3)}`

export function TaxWhy() {
  return (
    <p className="muted small">
      HMRC asks marketplaces like BiteBY to report what each seller earns, once a year. We only use these details for
      that report. They’re never shown on your shop, and only you and the BiteBY team can see them.
    </p>
  )
}

function TaxForm({ accountId, businessType, current, onSaved }: { accountId: string; businessType: string | null; current: TaxDetails | null; onSaved: () => void }) {
  const company = businessType === 'limited_company'
  const [kind, setKind] = useState<TaxDetails['tax_id_kind']>(current?.tax_id_kind ?? (company ? 'company' : 'nino'))
  const [taxId, setTaxId] = useState(current?.tax_id ?? '')
  const [dob, setDob] = useState(current?.date_of_birth ?? '')
  const [line1, setLine1] = useState(current?.address_line1 ?? '')
  const [line2, setLine2] = useState(current?.address_line2 ?? '')
  const [city, setCity] = useState(current?.city ?? '')
  const [postcode, setPostcode] = useState(current?.postcode ?? '')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setMessage('')
    const { error } = await supabase!.from('seller_tax_details').upsert({
      seller_account_id: accountId, tax_id_kind: kind, tax_id: taxId, date_of_birth: kind === 'company' ? null : dob || null,
      company_number: kind === 'company' ? taxId : null,
      address_line1: line1.trim(), address_line2: line2.trim() || null, city: city.trim(), postcode: postcode.trim(),
    })
    setBusy(false)
    if (error) return setMessage(error.message)
    onSaved()
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <label>
        Which number will you give?
        <select value={kind} onChange={(e) => setKind(e.target.value as TaxDetails['tax_id_kind'])}>
          {company && <option value="company">Company number (limited company)</option>}
          <option value="nino">National Insurance number</option>
          <option value="utr">UTR (if you do Self Assessment)</option>
        </select>
      </label>
      <label>
        {KIND_LABEL[kind]}
        <input required value={taxId} maxLength={20} autoCapitalize="characters" onChange={(e) => setTaxId(e.target.value.toUpperCase())}
          placeholder={kind === 'nino' ? 'QQ 12 34 56 C' : kind === 'utr' ? '10 numbers' : '8 characters, e.g. 01234567'} />
      </label>
      {kind !== 'company' && (
        <label>
          Date of birth
          <input required type="date" value={dob} onChange={(e) => setDob(e.target.value)} />
        </label>
      )}
      <label>
        {kind === 'company' ? 'Registered address' : 'Home address'}
        <input required maxLength={200} value={line1} onChange={(e) => setLine1(e.target.value)} placeholder="House number and street" autoComplete="address-line1" />
      </label>
      <input maxLength={200} value={line2} onChange={(e) => setLine2(e.target.value)} placeholder="Flat, building (optional)" aria-label="Address line 2" autoComplete="address-line2" />
      <div className="row">
        <label>
          Town or city
          <input required maxLength={100} value={city} onChange={(e) => setCity(e.target.value)} autoComplete="address-level2" />
        </label>
        <label>
          Postcode
          <input required maxLength={10} value={postcode} onChange={(e) => setPostcode(e.target.value.toUpperCase())} autoComplete="postal-code" />
        </label>
      </div>
      <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save tax details'}</button>
      {message && <p className="error small">{message}</p>}
    </form>
  )
}

// Black notice at the top of the dashboard while they're missing.
export function TaxAlert({ accountId }: { accountId: string }) {
  const { details, due } = useTaxDetails(accountId)
  if (details !== null) return null
  return (
    <a className="status insurance-alert" href="#tax" onClick={() => {
      const d = document.getElementById('tax') as HTMLDetailsElement | null
      if (d) d.open = true
    }}>
      <strong>Tax details:</strong> HMRC asks us to report what cooks earn{due ? `. Please add yours by ${new Date(`${due}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}` : ''}. Tap to add them.
    </a>
  )
}

// Collapsible card on the dashboard.
export function TaxCard({ accountId, businessType }: { accountId: string; businessType: string | null }) {
  const { details, load } = useTaxDetails(accountId)
  const [editing, setEditing] = useState(false)
  if (details === undefined) return null
  return (
    <details className="card tax-card" id="tax" open={details === null || undefined}>
      <summary>
        <span className="sum-row">
          <span className={`ins-dot ${details ? 'ok' : 'warn'}`} aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16"><rect x="5" y="3" width="14" height="18" rx="2" fill="#fff" /><path d="M8.5 8h7M8.5 12h7M8.5 16h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </span>
          <span className="sum-text">
            <strong>Tax details</strong>
            <span className="muted small">{details ? 'Added, for HMRC’s yearly report' : 'Needed for HMRC’s yearly report'}</span>
          </span>
        </span>
      </summary>
      <div className="details-body">
        <TaxWhy />
        {details && !editing
          ? <>
              <p className="small" style={{ margin: 0 }}>{masked(details)} · {details.postcode}</p>
              <button type="button" className="secondary" onClick={() => setEditing(true)}>Change tax details</button>
            </>
          : <TaxForm accountId={accountId} businessType={businessType} current={details} onSaved={() => { setEditing(false); load() }} />}
      </div>
    </details>
  )
}

type ReportRow = {
  legal_name: string | null; trading_name: string | null; business_type: string | null; date_of_birth: string | null
  tax_id_kind: string | null; tax_id: string | null; company_number: string | null; address: string | null; shop_name: string | null
  q1_orders: number; q1_paid_pence: number; q1_fees_pence: number; q2_orders: number; q2_paid_pence: number; q2_fees_pence: number
  q3_orders: number; q3_paid_pence: number; q3_fees_pence: number; q4_orders: number; q4_paid_pence: number; q4_fees_pence: number
  missing_details: boolean
}

// Admin > Reports: the yearly seller report for HMRC, as a spreadsheet.
export function HmrcReport() {
  const thisYear = new Date().getFullYear()
  const [year, setYear] = useState(new Date().getMonth() === 0 ? thisYear - 1 : thisYear)
  const [rows, setRows] = useState<ReportRow[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setRows(null)
    supabase!.rpc('admin_hmrc_report', { p_year: year }).then(({ data, error: e }) => {
      if (e) setError(e.message)
      else setRows((data ?? []) as ReportRow[])
    })
  }, [year])

  function csv() {
    if (!rows) return
    const head = ['Seller', 'Trading name', 'Business type', 'Date of birth', 'Tax number type', 'Tax number', 'Company number', 'Address', 'Shop',
      ...[1, 2, 3, 4].flatMap((q) => [`Q${q} orders`, `Q${q} paid to seller (£)`, `Q${q} BiteBY fees (£)`]), 'Details missing']
    const body = rows.map((r) => [r.legal_name, r.trading_name, r.business_type, r.date_of_birth, r.tax_id_kind, r.tax_id, r.company_number, r.address, r.shop_name,
      r.q1_orders, money(r.q1_paid_pence), money(r.q1_fees_pence), r.q2_orders, money(r.q2_paid_pence), money(r.q2_fees_pence),
      r.q3_orders, money(r.q3_paid_pence), money(r.q3_fees_pence), r.q4_orders, money(r.q4_paid_pence), money(r.q4_fees_pence),
      r.missing_details ? 'yes' : ''])
    downloadCsv(`biteby-hmrc-sellers-${year}.csv`, [head, ...body])
  }

  const missing = rows?.filter((r) => r.missing_details).length ?? 0
  return (
    <section className="card stack">
      <h2>HMRC seller report</h2>
      <p className="muted small">Every cook who sold in the year, with orders, what customers paid them and BiteBY’s fees for each quarter. Send it to HMRC (or your accountant) by 31 January.</p>
      <label>
        Year
        <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {[thisYear, thisYear - 1, thisYear - 2].map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </label>
      {error && <p className="error small">{error}</p>}
      {rows && <p className="small" style={{ margin: 0 }}>{rows.length} {rows.length === 1 ? 'cook' : 'cooks'} sold in {year}.{missing > 0 && ` ${missing} still ${missing === 1 ? 'needs' : 'need'} to add tax details.`}</p>}
      <button type="button" className="secondary" onClick={csv} disabled={!rows}>Download spreadsheet (CSV)</button>
    </section>
  )
}
