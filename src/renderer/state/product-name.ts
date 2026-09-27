import { useEffect, useState } from 'react';
import { DEFAULT_PRODUCT_NAME } from '@shared/product';

/** The product's name from its resolved config (`app:info`), never a
 *  literal: a product build supplies product.json and needs no source edit.
 *  DEFAULT_PRODUCT_NAME covers the frame before main answers — it is the
 *  same constant main defaults to, so the two cannot disagree. */
export function useProductName(): string {
  const [name, setName] = useState(DEFAULT_PRODUCT_NAME);
  useEffect(() => {
    let live = true;
    void window.kiagent
      .invoke('app:info', undefined)
      .then((info) => {
        if (live) setName(info.productName);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return name;
}
