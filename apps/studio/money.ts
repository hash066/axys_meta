/** Mirrors packages/campaign price(): USD $129.00, EUR €, GBP £, INR keeps "INR 129.00". */
export function money(currency: string | undefined, minor: number): string {
  const v = (minor / 100).toFixed(2);
  switch (currency ?? "USD") {
    case "USD":
      return `$${v}`;
    case "EUR":
      return `€${v}`;
    case "GBP":
      return `£${v}`;
    default:
      return `${currency} ${v}`;
  }
}
