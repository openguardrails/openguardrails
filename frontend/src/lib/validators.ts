import { z } from 'zod'

export const loginSchema = z.object({
  email: z.string().min(1).email(),
  password: z.string().min(1),
})

export type LoginFormData = z.infer<typeof loginSchema>

export const registerSchema = z.object({
  email: z.string().min(1).email(),
  password: z.string().min(8),
  confirmPassword: z.string().min(1),
}).refine((data) => data.password === data.confirmPassword, {
  message: 'Passwords do not match',
  path: ['confirmPassword'],
})

export type RegisterFormData = z.infer<typeof registerSchema>

export const forgotPasswordSchema = z.object({
  email: z.string().min(1).email(),
})

export type ForgotPasswordFormData = z.infer<typeof forgotPasswordSchema>

export const resetPasswordSchema = z.object({
  password: z.string().min(8),
  confirmPassword: z.string().min(1),
}).refine((data) => data.password === data.confirmPassword, {
  message: 'Passwords do not match',
  path: ['confirmPassword'],
})

export type ResetPasswordFormData = z.infer<typeof resetPasswordSchema>

export const verificationCodeSchema = z.object({
  verificationCode: z.string().min(1),
})

export type VerificationCodeFormData = z.infer<typeof verificationCodeSchema>

export const emailVerificationSchema = z.object({
  email: z.string().min(1).email(),
  verificationCode: z.string().min(1),
})

export type EmailVerificationFormData = z.infer<typeof emailVerificationSchema>
