export const MULTI_PRODUCT = "multi_product";
export const UNKNOWN_PRODUCT = "unknown";

export function productsInScope(scope) {
  if (!scope) return [];
  if (scope.product === MULTI_PRODUCT) {
    return [...new Set(scope.products ?? [])].sort();
  }
  return typeof scope.product === "string" ? [scope.product] : [];
}

export function scopeIncludesProduct(scope, product) {
  return productsInScope(scope).includes(product);
}

export function sameProductScope(left, right) {
  return JSON.stringify(productsInScope(left)) === JSON.stringify(productsInScope(right));
}
