/**
 * Simple event bus for cross-component communication
 * Used to notify components when data changes (e.g., scanner deletion)
 */

type EventHandler = (...args: any[]) => void;

class EventBus {
  private events: Map<string, Set<EventHandler>> = new Map();

  /**
   * Subscribe to an event
   * @param event - Event name
   * @param handler - Event handler function
   * @returns Unsubscribe function
   */
  on(event: string, handler: EventHandler): () => void {
    if (!this.events.has(event)) {
      this.events.set(event, new Set());
    }
    this.events.get(event)!.add(handler);

    // Return unsubscribe function
    return () => {
      const handlers = this.events.get(event);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.events.delete(event);
        }
      }
    };
  }

  /**
   * Emit an event
   * @param event - Event name
   * @param args - Event arguments
   */
  emit(event: string, ...args: any[]): void {
    const handlers = this.events.get(event);
    if (handlers) {
      handlers.forEach(handler => {
        try {
          handler(...args);
        } catch (error) {
          console.error(`Error in event handler for "${event}":`, error);
        }
      });
    }
  }

  /**
   * Remove all handlers for an event
   * @param event - Event name
   */
  off(event: string): void {
    this.events.delete(event);
  }

  /**
   * Remove all event handlers
   */
  clear(): void {
    this.events.clear();
  }
}

// Export singleton instance
export const eventBus = new EventBus();

// Event names constants
export const EVENTS = {
  SCANNER_DELETED: 'scanner:deleted',
  SCANNER_CREATED: 'scanner:created',
  SCANNER_UPDATED: 'scanner:updated',
  BLACKLIST_DELETED: 'blacklist:deleted',
  BLACKLIST_CREATED: 'blacklist:created',
  WHITELIST_DELETED: 'whitelist:deleted',
  WHITELIST_CREATED: 'whitelist:created',
  MARKETPLACE_SCANNER_PURCHASED: 'marketplace_scanner:purchased',
} as const;

