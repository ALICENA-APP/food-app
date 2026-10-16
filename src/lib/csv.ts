// Spreadsheet files (CSV) that open in Excel, Numbers and Google Sheets.

type Cell = string | number | null | undefined

function cell(v: Cell) {
  if (v === null || v === undefined) return ''
  const s = String(v)
  // Stops a spreadsheet treating text like "=SUM(...)" as a formula.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function toCsv(rows: Cell[][]) {
  return rows.map((r) => r.map(cell).join(',')).join('\r\n')
}

export function downloadCsv(filename: string, rows: Cell[][]) {
  // The byte-order mark makes Excel read £ and accents correctly.
  const url = URL.createObjectURL(new Blob(['﻿' + toCsv(rows)], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export const money = (pence: number | null | undefined) => ((pence ?? 0) / 100).toFixed(2)
