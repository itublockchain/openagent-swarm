import { EventEmitter } from 'events';
import { INetworkPort } from '../../../../shared/ports';
import { AXLEvent, EventType } from '../../../../shared/types';

export class EventBus implements INetworkPort {
  private emitter = new EventEmitter();

  constructor(private agentId: string) {}

  async emit<T>(event: AXLEvent<T>): Promise<void> {
    const serialized = JSON.stringify(event);
    console.log(`[AXL] → ${event.type}`, event.payload);
    this.emitter.emit(event.type, serialized);
    this.emitter.emit('*', serialized); // Wildcard emit
  }

  on<T>(type: EventType | '*', handler: (event: AXLEvent<T>) => void): void {
    this.emitter.on(type, (serialized: string) => {
      const event = JSON.parse(serialized) as AXLEvent<T>;
      handler(event);
    });
  }

  off(type: EventType): void {
    this.emitter.removeAllListeners(type);
  }
}
