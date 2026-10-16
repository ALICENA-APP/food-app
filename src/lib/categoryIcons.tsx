// Pictures for food categories and dietary labels.
const EMOJI: Record<string, string> = {
  all: '🍽️',
  'cakes-bakes': '🎂',
  desserts: '🍰',
  meals: '🍛',
  'sides-snacks': '🥟',
  breakfast: '🥞',
  drinks: '🥤',
  'preserves-sauces': '🫙',
  'meal-prep': '🍱',
  vegetarian: '🥗',
  vegan: '🌱',
  spicy: '🌶️',
}

export function CategoryIcon({ slug }: { slug: string }) {
  if (slug === 'halal') {
    return (
      <svg viewBox="0 0 40 40" className="halal-mark" aria-hidden="true">
        <circle cx="20" cy="20" r="18" fill="#22A55B" />
        <text x="20" y="23" textAnchor="middle" fontSize="8.5" letterSpacing="0.2" fontWeight="800" fill="#fff" fontFamily="Inter Variable, Inter, system-ui, sans-serif">HALAL</text>
      </svg>
    )
  }
  return <span aria-hidden="true">{EMOJI[slug] ?? '🍲'}</span>
}
