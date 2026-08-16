// Read-only ledger math for the web. Mirrors KiraLedger's balance derivation.
// The web never CREATES splits (the app does that and already allocated every
// sen), so we only REPLAY events and sum — no allocation logic here.
//
// Event payload contract (what the app's SyncClient pushes, and what the seed
// SQL inserts):
//   created / amended : { id, merchant, occurredAt, category?, payers:[{person,sen}], beneficiaries:[{person,sen}] }
//   voided            : { id }
//   settled           : { from, to, sen }

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
  const settlements: { from: string; to: string; sen: number }[] = []
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

export function fmt(sen: number): string {
  const neg = sen < 0
  const n = Math.abs(sen)
  const whole = Math.floor(n / 100).toLocaleString('en-US')
  const cents = String(n % 100).padStart(2, '0')
  return (neg ? '-RM ' : 'RM ') + whole + '.' + cents
}
