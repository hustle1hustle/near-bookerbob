// One price for a batch of buyers, design: Dan (DenisDI). The reference solver, the same
// enumeration as core/src/clearing.rs (both are checked against fixtures/clearing.json), and
// `check`, the bounds the contract's `propose_clearing` holds a proposal to. The solver only
// finds an assignment; the contract only checks bounds and recomputes every price itself.
//
// offers: [{ merchant, price, seats }], budgets: [amount]. Amounts are all BigInt or all
// Number (base units). No dependencies. agents/clearing.html carries the block between the
// markers verbatim (clearing.test.mjs compares them).
// clearing:begin
function seatsOf(offers, buyers) {
  const s = offers.flatMap((o) => Array.from({ length: Math.min(Number(o.seats), buyers) }, () => ({ price: o.price, merchant: o.merchant })));
  s.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));
  return s.slice(0, buyers);
}

// One line per r: the r cheapest seats, P the code price of the r-th, how many budgets reach P.
function steps(offers, budgets) {
  return seatsOf(offers, budgets.length).map((seat, i) => {
    const canPay = budgets.filter((b) => b >= seat.price).length;
    return { r: i + 1, merchant: seat.merchant, price: seat.price, canPay, valid: canPay >= i + 1 };
  });
}

// The largest valid r at the price of its r-th seat (a tie goes to the lower price). Seats go
// to the buyers who can pay it, the largest budget first: who is left out when more can pay
// than there are seats is the proposer's choice, not the price's.
function solve(offers, budgets) {
  let best = null;
  for (const s of steps(offers, budgets)) if (s.valid && (!best || s.r > best.r || (s.r === best.r && s.price < best.price))) best = s;
  if (!best) return null;
  const order = budgets.map((_, i) => i).filter((i) => budgets[i] >= best.price);
  order.sort((a, b) => (budgets[a] > budgets[b] ? -1 : budgets[a] < budgets[b] ? 1 : 0));
  order.length = best.r;
  const seats = seatsOf(offers, budgets.length);
  return { price: best.price, fills: order.map((b, i) => [b, seats[i].merchant]), leftOut: budgets.map((_, i) => i).filter((i) => !order.includes(i)) };
}

// The contract's bounds on a proposal (fills: [[buyer index, merchant]]): null when it would
// be accepted, or the reason it is refused, in the contract's words.
function check(offers, budgets, price, fills) {
  if (!fills.length) return "fill 1 to 100 seats";
  let top = null;
  const taken = {};
  for (let i = 0; i < fills.length; i++) {
    const [buyer, merchant] = fills[i];
    if (fills.slice(0, i).some((f) => f[0] === buyer)) return "a participant sits once";
    const o = offers.find((x) => x.merchant === merchant);
    if (!o) return "merchant did not reveal in this round";
    taken[merchant] = (taken[merchant] ?? 0) + 1;
    if (taken[merchant] > Number(o.seats)) return "more seats than the merchant declared for this round";
    if (o.price > price) return "price below a seat's code price";
    if (price > budgets[buyer]) return "price above a participant's budget";
    if (top === null || o.price > top) top = o.price;
  }
  return price === top ? null : "price is not the highest code price among the filled seats";
}

// A standing proposal is replaced only by more seats, or by the same number at a lower price.
function replaces(next, standing) {
  return !standing || next.fills.length > standing.fills.length || (next.fills.length === standing.fills.length && next.price < standing.price);
}
// clearing:end

export { check, replaces, solve, steps };
