import { useEffect, useState, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { message } from 'antd';
import { useTranslation } from 'react-i18next';
import { paymentService, PaymentVerificationResult } from '../services/payment';

export interface PaymentSuccessOptions {
  /**
   * Callback when payment is successfully verified
   */
  onSuccess?: (result: PaymentVerificationResult) => void;

  /**
   * Callback when payment verification fails
   */
  onError?: (error: string) => void;

  /**
   * Maximum number of verification attempts (default: 15)
   */
  maxAttempts?: number;

  /**
   * Polling interval in milliseconds (default: 2000)
   */
  pollingInterval?: number;

  /**
   * Whether to show toast notifications (default: true)
   */
  showToast?: boolean;
}

export interface PaymentSuccessState {
  /**
   * Whether payment verification is in progress
   */
  isVerifying: boolean;

  /**
   * Verification result (null if not started or in progress)
   */
  result: PaymentVerificationResult | null;

  /**
   * Error message if verification failed
   */
  error: string | null;
}

/**
 * Custom hook to handle payment success verification after redirect
 *
 * This hook:
 * 1. Detects payment=success and session_id URL params
 * 2. Polls backend to verify payment status
 * 3. Shows appropriate loading/success/error messages
 * 4. Calls callbacks when verification completes
 * 5. Cleans up URL params after handling
 *
 * Usage:
 * ```tsx
 * const { isVerifying, result } = usePaymentSuccess({
 *   onSuccess: (result) => {
 *     if (result.order_type === 'subscription') {
 *       refreshSubscription();
 *     } else if (result.order_type === 'package') {
 *       refreshPackages();
 *     }
 *   }
 * });
 * ```
 */
export function usePaymentSuccess(options: PaymentSuccessOptions = {}): PaymentSuccessState {
  const {
    onSuccess,
    onError,
    maxAttempts = 15,
    pollingInterval = 2000,
    showToast = true
  } = options;

  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();

  const [state, setState] = useState<PaymentSuccessState>({
    isVerifying: false,
    result: null,
    error: null
  });

  // Track processed sessions to prevent duplicate verification
  const processedSessionsRef = useRef<Set<string>>(new Set());

  const verifyPayment = useCallback(async (sessionId: string) => {
    let attempts = 0;
    let hideLoadingMessage: (() => void) | null = null;

    // Show loading message
    if (showToast) {
      hideLoadingMessage = message.loading(t('payment.verifying'), 0);
    }

    setState({
      isVerifying: true,
      result: null,
      error: null
    });

    const poll = async (): Promise<void> => {
      try {
        attempts++;

        const result = await paymentService.verifyPaymentSession(sessionId);

        // Payment completed successfully
        if (result.status === 'completed') {
          console.log('[usePaymentSuccess] Payment completed, attempts:', attempts);
          if (hideLoadingMessage) hideLoadingMessage();

          if (showToast) {
            console.log('[usePaymentSuccess] Showing success toast');
            message.success(t('payment.success'));
          }

          setState({
            isVerifying: false,
            result,
            error: null
          });

          if (onSuccess) {
            console.log('[usePaymentSuccess] Calling onSuccess callback');
            onSuccess(result);
          }

          // Clean up URL params
          console.log('[usePaymentSuccess] Cleaning up URL params');
          setSearchParams({});
          return;
        }

        // Payment failed
        if (result.status === 'failed' || result.status === 'not_found') {
          if (hideLoadingMessage) hideLoadingMessage();

          const errorMsg = result.message || t('payment.failed');

          if (showToast) {
            message.error(errorMsg);
          }

          setState({
            isVerifying: false,
            result,
            error: errorMsg
          });

          if (onError) {
            onError(errorMsg);
          }

          // Clean up URL params
          setSearchParams({});
          return;
        }

        // Still pending - continue polling if not exceeded max attempts
        if (attempts < maxAttempts) {
          setTimeout(poll, pollingInterval);
        } else {
          // Timeout
          if (hideLoadingMessage) hideLoadingMessage();

          const timeoutMsg = t('payment.verificationTimeout');

          if (showToast) {
            message.warning(timeoutMsg);
          }

          setState({
            isVerifying: false,
            result: null,
            error: timeoutMsg
          });

          if (onError) {
            onError(timeoutMsg);
          }

          // Clean up URL params
          setSearchParams({});
        }
      } catch (error) {
        if (hideLoadingMessage) hideLoadingMessage();

        const errorMsg = error instanceof Error ? error.message : t('payment.verificationError');

        if (showToast) {
          message.error(errorMsg);
        }

        setState({
          isVerifying: false,
          result: null,
          error: errorMsg
        });

        if (onError) {
          onError(errorMsg);
        }

        // Clean up URL params
        setSearchParams({});
      }
    };

    // Start polling
    await poll();
  }, [t, maxAttempts, pollingInterval, showToast, onSuccess, onError, setSearchParams]);

  // Check for payment success on mount and when URL params change
  useEffect(() => {
    const paymentStatus = searchParams.get('payment');
    const sessionId = searchParams.get('session_id');

    console.log('[usePaymentSuccess] useEffect triggered', {
      paymentStatus,
      sessionId,
      isVerifying: state.isVerifying,
      alreadyProcessed: sessionId ? processedSessionsRef.current.has(sessionId) : false,
      willTrigger: paymentStatus === 'success' && sessionId && !state.isVerifying && !processedSessionsRef.current.has(sessionId)
    });

    // Only handle if:
    // 1. Both params are present
    // 2. Not already verifying
    // 3. Haven't processed this session before
    if (
      paymentStatus === 'success' &&
      sessionId &&
      !state.isVerifying &&
      !processedSessionsRef.current.has(sessionId)
    ) {
      console.log('[usePaymentSuccess] Starting payment verification for session:', sessionId);
      // Mark as processed immediately to prevent duplicate processing
      processedSessionsRef.current.add(sessionId);
      verifyPayment(sessionId);
    }
  }, [searchParams, state.isVerifying, verifyPayment]);

  return state;
}

export default usePaymentSuccess;
