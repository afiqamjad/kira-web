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
