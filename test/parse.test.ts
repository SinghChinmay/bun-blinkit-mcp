import { describe, expect, test } from "bun:test";
import { extractOrders, extractProducts, parseReorderIds, toCartItem } from "../src/parse";

const searchFixture = {
  is_success: true,
  response: {
    snippets: [
      {
        widget_type: "product_card_snippet_type_2",
        data: {
          product_id: "581548",
          merchant_id: 31719,
          name: { text: "Veeba Herby Tomato Pizza & Pasta Sauce" },
          brand_name: { text: "Veeba" },
          variant: { text: "525 g" },
          mrp: { text: "₹180" },
          normal_price: { text: "₹148" },
          inventory: 4,
          image: { url: "https://cdn.grofers.com/x.png" },
          eta_tag: { title: { text: "earliest" } },
          atc_action: {
            add_to_cart: {
              cart_item: {
                product_id: 581548,
                merchant_id: 31719,
                product_name: "Veeba Herby Tomato Pizza & Pasta Sauce",
                quantity: 1,
                price: 148,
                mrp: 180,
                unit: "525 g",
                group_id: 1229883,
              },
            },
          },
        },
      },
      {
        // A header snippet must be ignored.
        widget_type: "image_text_vr_type_header",
        data: { identity: { id: "product_container" }, title: { text: "Showing results" } },
      },
    ],
  },
};

describe("extractProducts", () => {
  test("pulls clean products and ignores non-product snippets", () => {
    const products = extractProducts(searchFixture);
    expect(products).toHaveLength(1);
    const p = products[0];
    expect(p.product_id).toBe(581548);
    expect(p.name).toBe("Veeba Herby Tomato Pizza & Pasta Sauce");
    expect(p.brand).toBe("Veeba");
    expect(p.unit).toBe("525 g");
    expect(p.price).toBe(148);
    expect(p.mrp).toBe(180);
    expect(p.inventory).toBe(4);
    expect(p.cart_item?.group_id).toBe(1229883);
  });
});

describe("parseReorderIds", () => {
  test("parses a reorder deeplink", () => {
    expect(parseReorderIds("grofers://cart?product_ids=1,2,3&x=1")).toEqual([1, 2, 3]);
    expect(parseReorderIds(undefined)).toEqual([]);
  });
});

const orderFixture = {
  response: {
    snippets: [
      {
        data: {
          widget_type: "order_history_container_vr",
          tracking: {
            common_attributes: {
              order_id: "ORD-1",
              order_status: "DELIVERED",
              deeplink: "grofers://order?cart_id=999",
            },
          },
          children: [
            { image: { accessibility_text: { text: "Amul Milk" } } },
            { image: { accessibility_text: { text: "Brown Bread" } } },
            { left_underlined_subtitle: { text: "₹214" } },
            { subtitle: { text: "12 Jun, 4:30 pm" } },
            {
              click_action: {
                blinkit_deeplink: { url: "grofers://cart?product_ids=11,22" },
              },
            },
          ],
        },
      },
    ],
  },
};

describe("extractOrders", () => {
  test("extracts summary, totals and reorder ids", () => {
    const orders = extractOrders(orderFixture);
    expect(orders).toHaveLength(1);
    expect(orders[0].order_id).toBe("ORD-1");
    expect(orders[0].status).toBe("DELIVERED");
    expect(orders[0].cart_id).toBe("999");
    expect(orders[0].total).toBe(214);
    expect(orders[0].product_names).toEqual(["Amul Milk", "Brown Bread"]);
    expect(orders[0].reorder_product_ids).toEqual([11, 22]);
  });
});

describe("toCartItem", () => {
  test("normalizes a bare product into a cart item", () => {
    const item = toCartItem({ product_id: 1, merchant_id: 2, name: "Milk", price: 30 }, 2);
    expect(item).toMatchObject({ product_id: 1, merchant_id: 2, quantity: 2, price: 30 });
  });
});
