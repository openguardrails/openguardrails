import { z } from "zod"

// Personal email domains blacklist
const PERSONAL_EMAIL_DOMAINS = new Set([
  // Google
  'gmail.com', 'googlemail.com',
  // Microsoft
  'hotmail.com', 'outlook.com', 'live.com', 'msn.com',
  // Yahoo
  'yahoo.com', 'yahoo.cn', 'yahoo.co.jp', 'yahoo.co.uk',
  // Apple
  'icloud.com', 'me.com', 'mac.com',
  // Chinese personal email providers
  'qq.com', 'foxmail.com',
  '163.com', '126.com', 'yeah.net',
  'sina.com', 'sina.cn',
  'sohu.com',
  'aliyun.com',
  '139.com',
  '189.cn',
  // Other common personal email providers
  'aol.com',
  'protonmail.com', 'proton.me',
  'zoho.com',
  'mail.com',
  'gmx.com', 'gmx.net',
  'yandex.com', 'yandex.ru',
  'mail.ru',
  'tutanota.com',
  'fastmail.com',
])

// Check if email is from a personal email provider
export const isPersonalEmail = (email: string): boolean => {
  if (!email || !email.includes('@')) return true
  const domain = email.toLowerCase().split('@').pop() || ''
  return PERSONAL_EMAIL_DOMAINS.has(domain)
}

// Login form schema
export const loginSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
  password: z.string().min(1, "Password is required"),
})

export type LoginFormData = z.infer<typeof loginSchema>

// Register form schema with strong password validation
export const registerSchema = z.object({
  email: z.string()
    .email("Please enter a valid email address")
    .refine((email) => !isPersonalEmail(email), {
      message: "Personal email addresses are not allowed. Please use your enterprise email.",
    }),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
    .regex(/[a-z]/, "Password must contain at least one lowercase letter")
    .regex(/\d/, "Password must contain at least one number"),
  confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
})

export type RegisterFormData = z.infer<typeof registerSchema>

// Forgot password schema
export const forgotPasswordSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
})

export type ForgotPasswordFormData = z.infer<typeof forgotPasswordSchema>

// Reset password schema
export const resetPasswordSchema = z.object({
  password: z.string().min(8, "Password must be at least 8 characters"),
  confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ["confirmPassword"],
})

export type ResetPasswordFormData = z.infer<typeof resetPasswordSchema>

// Verification code schema
export const verificationCodeSchema = z.object({
  verificationCode: z.string().length(6, "Verification code must be 6 digits"),
})

export type VerificationCodeFormData = z.infer<typeof verificationCodeSchema>

// Email verification schema (for Verify page - includes email + code)
export const emailVerificationSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
  verificationCode: z.string().length(6, "Verification code must be 6 digits"),
})

export type EmailVerificationFormData = z.infer<typeof emailVerificationSchema>
