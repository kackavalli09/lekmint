import { forwardRef, useRef, type ComponentProps, type ChangeEvent } from "react";
import { Input } from "@/components/ui/core";
import { digitsOnly, groupDigitString } from "@/lib/utils";

interface AmountInputProps
  extends Omit<ComponentProps<typeof Input>, "type" | "value" | "onChange"> {
  /** Raw digit string (or number) — no separators. */
  value: string | number;
  /** Called with the raw digit string (no separators). */
  onValueChange: (raw: string) => void;
}

/**
 * Integer amount input that shows thousands separators while typing but
 * reports a clean digit string. Keeps the caret stable across reformatting
 * by counting digits left of the caret. Numeric keyboard on mobile.
 */
export const AmountInput = forwardRef<HTMLInputElement, AmountInputProps>(
  ({ value, onValueChange, ...props }, ref) => {
    const innerRef = useRef<HTMLInputElement | null>(null);
    const display = value === "" || value == null ? "" : groupDigitString(digitsOnly(String(value)));

    const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
      const el = e.target;
      const caret = el.selectionStart ?? el.value.length;
      const digitsBeforeCaret = digitsOnly(el.value.slice(0, caret)).length;
      const raw = digitsOnly(el.value);
      onValueChange(raw);
      requestAnimationFrame(() => {
        const node = innerRef.current;
        if (!node) return;
        const formatted = raw === "" ? "" : groupDigitString(raw);
        let pos = 0;
        let seen = 0;
        while (pos < formatted.length && seen < digitsBeforeCaret) {
          if (/\d/.test(formatted[pos]!)) seen++;
          pos++;
        }
        node.setSelectionRange(pos, pos);
      });
    };

    return (
      <Input
        {...props}
        ref={(node) => {
          innerRef.current = node;
          if (typeof ref === "function") ref(node);
          else if (ref) ref.current = node;
        }}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={display}
        onChange={handleChange}
      />
    );
  },
);
AmountInput.displayName = "AmountInput";
