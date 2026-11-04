// Read-only ledger math for the web. Mirrors KiraLedger's balance derivation.
//
// Event payload contract:
//   created / amended : { id, merchant, occurredAt, category?, payers:[{person,sen}], beneficiaries:[{person,sen}] }
//   voided            : { id }
//   settled           : { from, to, sen, expenseId? }   ← expenseId ties a settle to one activity

export type Alloc = { person: string; sen: number }
export type Expense = {
  id: string
  merchant: string
  occurredAt: string
  category?: string
  payers: Alloc[]
  beneficiaries: Alloc[]
}
export type EventRow = { kind: string; payload: any }

function replay(events: EventRow[]) {
  const live: Record<string, Expense> = {}
  const settlements: { from: string; to: string; sen: number; expenseId?: string }[] = []
  for (const e of events) {
    if (e.kind === 'created' || e.kind === 'amended') live[e.payload.id] = e.payload
    else if (e.kind === 'voided') delete live[e.payload.id]
    else if (e.kind === 'settled') settlements.push(e.payload)
  }
  return { expenses: Object.values(live), settlements }
}

// Net position for one person. Positive = owed to them. Sums to zero overall.
export function balanceFor(events: EventRow[], person: string): number {
  const { expenses, settlements } = replay(events)
  let sen = 0
  for (const e of expenses) {
    for (const p of e.payers) if (p.person === person) sen += p.sen
    for (const b of e.beneficiaries) if (b.person === person) sen -= b.sen
  }
  for (const s of settlements) {
    if (s.from === person) sen += s.sen
    if (s.to === person) sen -= s.sen
  }
  return sen
}

// Only the expenses this person is actually part of.
export function activityFor(events: EventRow[], person: string): Expense[] {
  const { expenses } = replay(events)
  return expenses
    .filter(
      (e) =>
        e.payers.some((p) => p.person === person) ||
        e.beneficiaries.some((b) => b.person === person && b.sen !== 0)
    )
    .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1))
}

export function paidBy(e: Expense, person: string): boolean {
  return e.payers.some((p) => p.person === person)
}

export function shareOf(e: Expense, person: string): number {
  return e.beneficiaries.find((b) => b.person === person)?.sen ?? 0
}

// Does this person still owe on this expense? (has a share, didn't pay it)
export function owesOn(e: Expense, person: string): boolean {
  return !paidBy(e, person) && shareOf(e, person) > 0
}

// The set of expense ids this person has already settled.
export function settledExpenseIds(events: EventRow[], person: string): Set<string> {
  const out = new Set<string>()
  for (const ev of events) {
    if (ev.kind === 'settled' && ev.payload?.from === person && ev.payload?.expenseId) {
      out.add(ev.payload.expenseId)
    }
  }
  return out
}

export type ExpenseSettle = {
  share: number      // what this person owes on the expense
  covered: number    // how much of that is already paid
  remaining: number  // what's left to pay (0 = settled)
}

// How much of each expense this person owes has already been paid.
//
// Settle-ups don't have to be made one expense at a time: the app settles a whole
// balance at once (a "Mark paid" for the total). So we work from the person's real
// net position and spread what's been paid over the expenses they owe on:
//   1. a settle-up tied to an expense (expenseId) covers that expense first;
//   2. whatever else has been paid covers the oldest expenses first.
// Remaining never exceeds the person's net balance, so nothing can be paid twice.
export function settleStatus(events: EventRow[], person: string): Map<string, ExpenseSettle> {
  const { expenses, settlements } = replay(events)

  const owed = expenses
    .filter((e) => owesOn(e, person))
    .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1))

  const totalOwed = owed.reduce((n, e) => n + shareOf(e, person), 0)
  const netOwes = Math.max(-balanceFor(events, person), 0)
  const stillOwes = Math.min(netOwes, totalOwed)

  const direct = new Map<string, number>()
  for (const s of settlements) {
    if (s.from === person && s.expenseId) {
      direct.set(s.expenseId, (direct.get(s.expenseId) ?? 0) + s.sen)
    }
  }

  let directTotal = 0
  const rows = owed.map((e) => {
    const share = shareOf(e, person)
    const d = Math.min(share, direct.get(e.id) ?? 0)
    directTotal += d
    return { id: e.id, share, d }
  })

  let pool = Math.max(0, totalOwed - stillOwes - directTotal)
  const out = new Map<string, ExpenseSettle>()
  for (const r of rows) {
    const take = Math.min(r.share - r.d, pool)
    pool -= take
    const covered = r.d + take
    out.set(r.id, { share: r.share, covered, remaining: r.share - covered })
  }
  return out
}

export function fmt(sen: number): string {
  const neg = sen < 0
  const n = Math.abs(sen)
  const whole = Math.floor(n / 100).toLocaleString('en-US')
  const cents = String(n % 100).padStart(2, '0')
  return (neg ? '-RM ' : 'RM ') + whole + '.' + cents
}

// ---- Settle up: who pays whom ----------------------------------------------
// Mirrors the iOS app exactly (KiraLedger's Ledger.simplify and the app's
// DirectDebts), so the web link and the app always give the same instruction.

export type Transfer = { from: string; to: string; sen: number }
export type SettleMode = 'simplified' | 'direct'

// Everyone's net position. Positive = owed to them.
export function allBalances(events: EventRow[]): Record<string, number> {
  const { expenses, settlements } = replay(events)
  const out: Record<string, number> = {}
  const add = (p: string, sen: number) => { out[p] = (out[p] ?? 0) + sen }
  for (const e of expenses) {
    for (const p of e.payers) add(p.person, p.sen)
    for (const b of e.beneficiaries) add(b.person, -b.sen)
  }
  for (const s of settlements) { add(s.from, s.sen); add(s.to, -s.sen) }
  for (const k of Object.keys(out)) if (out[k] === 0) delete out[k]
  return out
}

// Simplified: the fewest transfers that settle everyone. Largest debtor pays the
// largest creditor first; ties broken by name, so every device agrees.
export function simplify(balances: Record<string, number>): Transfer[] {
  const order = (a: { person: string; amount: number }, b: { person: string; amount: number }) =>
    a.amount === b.amount ? (a.person < b.person ? -1 : a.person > b.person ? 1 : 0) : b.amount - a.amount
  const debtors = Object.entries(balances).filter(([, v]) => v < 0)
    .map(([person, v]) => ({ person, amount: -v })).sort(order)
  const creditors = Object.entries(balances).filter(([, v]) => v > 0)
    .map(([person, v]) => ({ person, amount: v })).sort(order)
  const out: Transfer[] = []
  let i = 0, j = 0
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].amount, creditors[j].amount)
    if (amount > 0) out.push({ from: debtors[i].person, to: creditors[j].person, sen: amount })
    debtors[i].amount -= amount; creditors[j].amount -= amount
    if (debtors[i].amount === 0) i++
    if (creditors[j].amount === 0) j++
  }
  return out
}

// Direct: each pair settles only what they owe each other. For every expense,
// each person owes the payer their share; payments already made between the
// two come off; what's left is netted per pair.
export function directTransfers(events: EventRow[]): Transfer[] {
  const { expenses, settlements } = replay(events)
  const owed = new Map<string, Map<string, number>>()   // owed[a][b] = a owes b
  const add = (debtor: string, creditor: string, sen: number) => {
    if (debtor === creditor || sen === 0) return
    const row = owed.get(debtor) ?? new Map<string, number>()
    row.set(creditor, (row.get(creditor) ?? 0) + sen)
    owed.set(debtor, row)
  }
  for (const e of expenses) {
    const total = e.payers.reduce((n, p) => n + p.sen, 0)
    if (total <= 0) continue
    const payers = e.payers.filter((p) => p.sen > 0)
    for (const share of e.beneficiaries) {
      if (share.sen <= 0) continue
      let given = 0
      payers.forEach((payer, idx) => {
        const part = idx === payers.length - 1 ? share.sen - given : Math.trunc((share.sen * payer.sen) / total)
        given += part
        add(share.person, payer.person, part)
      })
    }
  }
  for (const s of settlements) add(s.from, s.to, -s.sen)

  const people = new Set<string>()
  for (const [a, row] of owed) { people.add(a); for (const b of row.keys()) people.add(b) }
  const sorted = [...people].sort()
  const out: Transfer[] = []
  sorted.forEach((a, i) => {
    for (const b of sorted.slice(i + 1)) {
      const net = (owed.get(a)?.get(b) ?? 0) - (owed.get(b)?.get(a) ?? 0)
      if (net > 0) out.push({ from: a, to: b, sen: net })
      else if (net < 0) out.push({ from: b, to: a, sen: -net })
    }
  })
  return out.sort((x, y) => y.sen - x.sen || (x.from + '>' + x.to < y.from + '>' + y.to ? -1 : 1))
}

export function transfersFor(events: EventRow[], mode: SettleMode, person: string): Transfer[] {
  const all = mode === 'direct' ? directTransfers(events) : simplify(allBalances(events))
  return all.filter((t) => t.from === person || t.to === person)
}
