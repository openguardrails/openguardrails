import * as React from "react"
import { cn } from "@/lib/utils"

export interface InputNumberProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  min?: number
  max?: number
  value?: number
  onChange?: (value: number | undefined) => void
}

const InputNumber = React.forwardRef<HTMLInputElement, InputNumberProps>(
  ({ className, min, max, value, onChange, ...props }, ref) => {
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value === '' ? undefined : Number(e.target.value)

      if (newValue !== undefined) {
        if (min !== undefined && newValue < min) return
        if (max !== undefined && newValue > max) return
      }

      onChange?.(newValue)
    }

    return (
      <input
        type="number"
        className={cn(
          "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        min={min}
        max={max}
        value={value ?? ''}
        onChange={handleChange}
        ref={ref}
        {...props}
      />
    )
  }
)
InputNumber.displayName = "InputNumber"

export { InputNumber }
