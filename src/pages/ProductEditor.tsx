import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { link, navigate } from '../lib/router'
import { DIETARY, type Allergen, type Category, type Presence, type Product } from '../lib/types'
import { deletePhoto, photoUrl, uploadPhoto } from '../lib/images'
import { ImageCropper } from '../lib/ImageCropper'

const PRESENCE_LABEL: Record<Presence, string> = {
  contains: 'Contains',
  may_contain: 'May contain',
  not_present: 'No',
}

type Loaded = {
  shopId: string
  product: Product | null
  allergens: Allergen[]
  categories: Category[]
  answers: Record<string, Presence>
}

export default function ProductEditor({ productId }: { productId: string | null }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    ;(async () => {
      const db = supabase!
      const { data: account } = await db.from('seller_accounts').select('id').maybeSingle()
      const { data: shops } = account
        ? await db.from('shops').select('id').eq('seller_account_id', account.id).limit(1)
        : { data: [] }
      const shopId = shops?.[0]?.id
      if (!shopId) return setError('Set up your shop first.')
      const [a, c] = await Promise.all([
        db.from('allergens').select('code, name').order('name'),
        db.from('categories').select('id, name').order('sort'),
      ])
      let product: Product | null = null
      const answers: Record<string, Presence> = {}
      if (productId) {
        const { data: p } = await db.from('products').select('*').eq('id', productId).maybeSingle()
        if (!p) return setError('Item not found.')
        product = p
        const { data: rows } = await db
          .from('product_allergens')
          .select('allergen_code, presence')
          .eq('product_id', productId)
          .is('variant_id', null)
          .is('addon_id', null)
        for (const r of rows ?? []) answers[r.allergen_code] = r.presence
      }
      setLoaded({ shopId, product, allergens: a.data ?? [], categories: c.data ?? [], answers })
    })()
  }, [productId])

  if (error) return <p className="card">{error}</p>
  if (!loaded) return <p className="muted">Loading…</p>
  return <Editor key={productId ?? 'new'} {...loaded} />
}

function Editor({ shopId, product, allergens, categories, answers: initialAnswers }: Loaded) {
  const [name, setName] = useState(product?.name ?? '')
  const [description, setDescription] = useState(product?.description ?? '')
  const [categoryId, setCategoryId] = useState(product?.category_id ?? '')
  const [price, setPrice] = useState(product ? (product.price_pence / 100).toFixed(2) : '')
  const [portion, setPortion] = useState(product?.portion ?? '')
  const [ingredients, setIngredients] = useState(product?.ingredients ?? '')
  const [mayContainNotes, setMayContainNotes] = useState(product?.may_contain_notes ?? '')
  const [collectionOk, setCollectionOk] = useState(product?.collection_ok ?? true)
  const [deliveryOk, setDeliveryOk] = useState(product?.delivery_ok ?? true)
  const [lead, setLead] = useState(String(product?.min_lead_hours ?? 0))
  const [dietary, setDietary] = useState<string[]>(product?.dietary ?? [])
  const [answers, setAnswers] = useState<Record<string, Presence>>(initialAnswers)
  const [confirmed, setConfirmed] = useState(false)
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)

  const allAnswered = allergens.every((a) => answers[a.code])
  const isPublished = product?.status === 'published'

  async function save(publish: boolean) {
    setMessage('')
    if (!collectionOk && !deliveryOk) return setMessage('Choose collection, delivery or both.')
    const pricePence = Math.round(parseFloat(price) * 100)
    if (!(pricePence >= 50 && pricePence <= 100000)) return setMessage('Price must be between £0.50 and £1,000.')
    if (publish && !allAnswered) return setMessage('Answer all 14 allergens before putting this on sale.')
    if (publish && !confirmed) return setMessage('Tick the box to confirm the allergen information.')
    setSaving(true)
    const db = supabase!
    const values = {
      name: name.trim(),
      description: description.trim() || null,
      category_id: categoryId || null,
      price_pence: pricePence,
      portion: portion.trim() || null,
      ingredients: ingredients.trim() || null,
      may_contain_notes: mayContainNotes.trim() || null,
      collection_ok: collectionOk,
      delivery_ok: deliveryOk,
      dietary,
      min_lead_hours: Number(lead) || null,
    }

    // 1. Save the item as a draft (new items get their id here).
    const id = product?.id ?? crypto.randomUUID()
    const { error: saveError } = product
      ? await db.from('products').update(values).eq('id', id)
      : await db.from('products').insert({ ...values, id, shop_id: shopId })
    if (saveError) return fail(saveError.message)

    // 2. Save allergen answers. Any change takes the item off sale until re-confirmed.
    const changed = allergens.filter((a) => answers[a.code] && answers[a.code] !== initialAnswers[a.code])
    if (changed.length) {
      const { error } = await db.from('product_allergens').upsert(
        changed.map((a) => ({ product_id: id, variant_id: null, addon_id: null, allergen_code: a.code, presence: answers[a.code] })),
        { onConflict: 'product_id,variant_id,addon_id,allergen_code' },
      )
      if (error) return fail(error.message)
    }

    // 3. Publish, with the seller's allergen confirmation.
    if (publish) {
      const { error } = await db
        .from('products')
        .update({ status: 'published', allergens_confirmed_at: new Date().toISOString() })
        .eq('id', id)
      if (error) return fail(error.message)
    }
    // A new draft stays open so photos can be added straight away.
    navigate(!product && !publish ? `/sell/products/${id}` : '/sell/products')
  }

  function fail(text: string) {
    setSaving(false)
    setMessage(text)
  }

  async function takeOffSale() {
    const { error } = await supabase!.from('products').update({ status: 'draft' }).eq('id', product!.id)
    if (error) setMessage(error.message)
    else navigate('/sell/products')
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    save(false)
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <p>
        <a href="/sell/products" onClick={link('/sell/products')}>← Menu</a>
      </p>
      <h1>{product ? 'Edit item' : 'New item'}</h1>
      {isPublished && (
        <p className="status">
          On sale now. Changing the ingredients or allergens takes it off sale until you confirm again.
        </p>
      )}

      <div className="card">
        <label>
          Name
          <input required minLength={2} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Jollof rice with chicken" />
        </label>
        <label>
          Description
          <textarea maxLength={2000} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="row">
          <label>
            Price (£)
            <input required type="number" min="0.5" max="1000" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} />
          </label>
          <label>
            Portion
            <input maxLength={60} value={portion} onChange={(e) => setPortion(e.target.value)} placeholder="e.g. Serves 2" />
          </label>
        </div>
        <label>
          Category
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Choose…</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <label>
          Notice needed
          <select value={lead} onChange={(e) => setLead(e.target.value)}>
            <option value="0">None: can be ordered for today</option>
            {[2, 4, 12, 24, 48, 72].map((h) => <option key={h} value={h}>{h < 24 ? `${h} hours` : `${h / 24} ${h === 24 ? 'day' : 'days'}`} ahead</option>)}
          </select>
        </label>
        <div className="stack" style={{ gap: 8 }}>
          <strong className="small">Suitable for (optional)</strong>
          <div className="tags">
            {DIETARY.map((d) => (
              <button key={d.code} type="button" className={`chip ${dietary.includes(d.code) ? 'on' : ''}`}
                onClick={() => setDietary(dietary.includes(d.code) ? dietary.filter((x) => x !== d.code) : [...dietary, d.code])}>
                {d.name}
              </button>
            ))}
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={collectionOk} onChange={(e) => setCollectionOk(e.target.checked)} />
          Can be collected
        </label>
        <label className="check">
          <input type="checkbox" checked={deliveryOk} onChange={(e) => setDeliveryOk(e.target.checked)} />
          Can be delivered
        </label>
      </div>

      {product ? (
        <Photos shopId={shopId} productId={product.id} />
      ) : (
        <p className="muted small">Save the item as a draft first, then you can add photos.</p>
      )}

      <div className="card">
        <h2>Ingredients</h2>
        <textarea maxLength={2000} rows={3} value={ingredients} onChange={(e) => setIngredients(e.target.value)} placeholder="List every ingredient, including what's in sauces and spice mixes" />
      </div>

      <div className="card">
        <h2>Allergens</h2>
        <p className="muted small">Answer all 14. If you are not sure, choose "May contain".</p>
        {allergens.map((a) => (
          <fieldset key={a.code} className={`allergen ${answers[a.code] ? '' : 'unanswered'}`}>
            <legend>{a.name}</legend>
            <div className="segmented">
              {(['contains', 'may_contain', 'not_present'] as Presence[]).map((p) => (
                <label key={p} className={answers[a.code] === p ? `on ${p}` : ''}>
                  <input type="radio" name={a.code} value={p} checked={answers[a.code] === p} onChange={() => setAnswers({ ...answers, [a.code]: p })} />
                  {PRESENCE_LABEL[p]}
                </label>
              ))}
            </div>
          </fieldset>
        ))}
        <label>
          Cross-contamination notes (optional)
          <textarea maxLength={500} rows={2} value={mayContainNotes} onChange={(e) => setMayContainNotes(e.target.value)} placeholder="e.g. Made in a kitchen that also uses nuts" />
        </label>
      </div>

      <div className="card">
        <label className="check">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          I confirm the ingredients and allergen information for this item are complete and correct.
        </label>
        <button type="button" disabled={saving} onClick={() => save(true)}>
          {saving ? 'Saving…' : isPublished ? 'Save and keep on sale' : 'Save and put on sale'}
        </button>
        <button type="submit" className="secondary" disabled={saving}>{isPublished ? 'Save' : 'Save as draft'}</button>
        {isPublished && (
          <button type="button" className="link" onClick={takeOffSale}>Take off sale</button>
        )}
        {message && <p className="error">{message}</p>}
      </div>
    </form>
  )
}

type Photo = { id: string; path: string; sort: number }

function Photos({ shopId, productId }: { shopId: string; productId: string }) {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [queue, setQueue] = useState<File[]>([])

  const load = useCallback(async () => {
    const { data } = await supabase!.from('product_images').select('id, path, sort').eq('product_id', productId).order('sort')
    setPhotos(data ?? [])
  }, [productId])

  useEffect(() => {
    load()
  }, [load])

  // Chosen photos are cropped one at a time, then saved.
  function choose(files: FileList | null) {
    if (!files?.length) return
    setMessage('')
    setQueue(Array.from(files).slice(0, 4 - photos.length))
  }

  async function add(blob: Blob) {
    setQueue((q) => q.slice(1))
    setBusy(true)
    try {
      const path = await uploadPhoto(shopId, blob)
      const sort = photos.length ? Math.max(...photos.map((p) => p.sort)) + 1 : 0
      const { error } = await supabase!.from('product_images').insert({ product_id: productId, path, sort })
      if (error) {
        await deletePhoto(path)
        throw new Error(error.message)
      }
    } catch (e) {
      setMessage((e as Error).message)
    }
    setBusy(false)
    load()
  }

  async function remove(photo: Photo) {
    await supabase!.from('product_images').delete().eq('id', photo.id)
    await deletePhoto(photo.path)
    load()
  }

  async function makeFirst(photo: Photo) {
    const first = Math.min(...photos.map((p) => p.sort))
    await supabase!.from('product_images').update({ sort: first - 1 }).eq('id', photo.id)
    load()
  }

  return (
    <div className="card">
      <h2>Photos</h2>
      <p className="muted small">Up to 4. The first one is shown on your menu. You can drag and zoom each photo to frame your dish.</p>
      <div className="photos">
        {photos.map((p, i) => (
          <figure key={p.id}>
            <img src={photoUrl(p.path)!} alt="" />
            <figcaption>
              {i > 0 && <button type="button" className="link small-btn" onClick={() => makeFirst(p)}>Make first</button>}
              <button type="button" className="link small-btn" onClick={() => remove(p)}>Remove</button>
            </figcaption>
          </figure>
        ))}
      </div>
      {photos.length < 4 && (
        <label className="button secondary upload">
          {busy ? 'Uploading…' : 'Add photos'}
          <input type="file" accept="image/*" multiple disabled={busy} onChange={(e) => { choose(e.target.files); e.target.value = '' }} />
        </label>
      )}
      {message && <p className="error">{message}</p>}
      {queue.length > 0 && (
        <ImageCropper
          key={`${queue.length}-${queue[0].name}`}
          file={queue[0]}
          aspect={4 / 3}
          width={1200}
          title={queue.length > 1 ? `Dish photo (${queue.length} to go)` : 'Dish photo'}
          hint="This is how it looks on your menu and the dish page."
          onCancel={() => setQueue((q) => q.slice(1))}
          onDone={add}
        />
      )}
    </div>
  )
}
