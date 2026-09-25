/** Where floating surfaces mount: inside the app's `.ac` root, whose
 *  `.ac *` rule is the only source of `box-sizing: border-box`. */
export function portalRoot(): HTMLElement {
  return (document.querySelector('.ac') as HTMLElement | null) ?? document.body;
}

export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
