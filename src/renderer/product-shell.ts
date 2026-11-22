import type React from 'react';
import type { View, ViewParams } from '@renderer/state/view';

/** The shell parts a product may supply (`PRODUCT_SHELL` in
 *  src/renderer/composition.tsx). Every part is optional; core's own is
 *  used for any the product leaves out. */
export interface ProductShell {
  /** The full-window screen shown while nobody is signed in. */
  SignIn?: React.ComponentType;
  /** The signed-in shell's sidebar. */
  Sidebar?: React.ComponentType;
  /** Wraps the window once someone is signed in — a product gate that must
   *  be able to cover the shell and its loading screen. */
  Frame?: React.ComponentType<{ children: React.ReactNode }>;
  /** A hook the app root calls on every render, signed in or not. */
  useShell?: (shell: {
    /** Who is signed in, as one comparable string; `null` for nobody. */
    principal: string | null;
    navigate: (to: View, params?: ViewParams) => void;
  }) => void;
}
