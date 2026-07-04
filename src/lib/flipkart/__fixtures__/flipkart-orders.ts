// Builds payloads shaped like flipkart.com's real "My Orders" response
// (RESPONSE.multipleOrderDetailsView.orders[], each with a units map + productDataBag),
// so tests exercise the same structure the live parser handles.

export interface FlipkartOrderSpec {
  orderId: string;
  titles: string[]; // one entry per unit; duplicates allowed (parser dedups by title)
  heading: string; // moRedesignHeading, e.g. "Delivered on Jun 26" / "Out for delivery"
  deliveredMs?: number | null;
  promisedMs?: number | null;
  orderDateMs?: number;
  otp?: string | null;
  shareToken?: string; // -> accessToOrderDataBag.endUser.id, needed by the detail endpoint
}

function buildOrder(spec: FlipkartOrderSpec) {
  const uniqueTitles = [...new Set(spec.titles)];
  const productDataBag: Record<string, unknown> = {};
  const listingByTitle: Record<string, string> = {};
  uniqueTitles.forEach((title, i) => {
    const listingId = `LST_${spec.orderId}_${i}`;
    listingByTitle[title] = listingId;
    productDataBag[listingId] = { productBasicData: { title } };
  });

  const units: Record<string, unknown> = {};
  spec.titles.forEach((title, u) => {
    units[`${spec.orderId}_u${u}`] = {
      metaData: {
        listingId: listingByTitle[title],
        fsn: `FSN_${spec.orderId}_${u}`,
        itemId: `${spec.orderId}_u${u}`,
        moRedesignHeading: spec.heading,
      },
      deliveryDataBag: {
        promiseDataBag: {
          actualDeliveredDate: spec.deliveredMs ?? null,
          promisedDate: spec.promisedMs ?? null,
        },
        otpCallout: spec.otp ? { otp: spec.otp } : null,
      },
    };
  });

  return {
    orderMetaData: {
      orderId: spec.orderId,
      orderDate: spec.orderDateMs ?? 0,
      numberOfItems: spec.titles.length,
    },
    ...(spec.shareToken ? { accessToOrderDataBag: { endUser: { id: spec.shareToken } } } : {}),
    productDataBag,
    units,
  };
}

export function buildFlipkartPayload(orders: FlipkartOrderSpec[]): unknown {
  return { RESPONSE: { multipleOrderDetailsView: { orders: orders.map(buildOrder) } } };
}
