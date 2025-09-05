import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { NexxHomebridgePlatform } from './platform';
import { FSM } from './nxg200_state_machine';

enum GarageDoorState {
  Open = 1,
  Closed = 2,
}

interface Device {
  DeviceId: string;
  DeviceNickName: string;
  DeviceStatus: GarageDoorState;
  LastOperationTimestamp: string;
  ProductCode: string;
  DeviceType?: string; // <-- add DeviceType so we can pass it to the SDK
}

export class NXG200 {
  private readonly service: Service;
  private readonly fsm;

  constructor(
    private readonly platform: NexxHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const device: Device = accessory.context.device;

    this.fsm = new FSM();
    this.fsm.deviceId = device.DeviceId;
    this.fsm.log = platform.log;
    this.fsm.platformUUID = accessory.UUID;

    // -----
    // Wrap the SDK so fsm.open()/fsm.close() automatically include DeviceType/ProductCode.
    // This avoids touching the FSM internals.
    // -----
    const baseClient: any = platform.nexxApiClient as any;
    const boundOpen = baseClient.open?.bind(baseClient);
    const boundClose = baseClient.close?.bind(baseClient);

    const deviceMeta = {
      DeviceType: device.DeviceType,       // e.g., "NexxGate" or "NexxGarage"
      ProductCode: device.ProductCode,     // e.g., "NXGT1", "NXG200"
    };

    // Provide a per-accessory client that defaults metadata when not supplied
    const clientAdapter = {
      ...baseClient,
      open: async (deviceId: string, devArg?: any) =>
        await boundOpen(deviceId, devArg ?? deviceMeta),
      close: async (deviceId: string, devArg?: any) =>
        await boundClose(deviceId, devArg ?? deviceMeta),
    };

    this.fsm.nexxApiClient = clientAdapter;
    // -----

    this.resetDeviceState(device);

    // create a new Garage Door Opener service
    this.service = accessory.getService(platform.Service.GarageDoorOpener)
      || accessory.addService(platform.Service.GarageDoorOpener);

    accessory.getService(platform.Service.AccessoryInformation)!
      .setCharacteristic(platform.Characteristic.Manufacturer, 'Nexx')
      .setCharacteristic(platform.Characteristic.Model, device.ProductCode)
      .setCharacteristic(platform.Characteristic.SerialNumber, device.DeviceId);

    this.service.setCharacteristic(platform.Characteristic.Name, device.DeviceNickName);

    // create handlers for required characteristics
    this.service.getCharacteristic(platform.Characteristic.CurrentDoorState)
      .onGet(this.getCurrentDoorState.bind(this));

    this.service.getCharacteristic(platform.Characteristic.TargetDoorState)
      .onGet(this.getTargetDoorState.bind(this))
      .onSet(this.setTargetDoorState.bind(this));

    this.service.getCharacteristic(platform.Characteristic.ObstructionDetected)
      .onGet(this.getObstructionDetected.bind(this));

    setInterval(async () => {
      platform.log.debug(`Checking on the status of (${this.fsm})`);
      if (!this.fsm.isTransitioning()) {
        const { Result: d } = await platform.nexxApiClient.getDeviceState(this.fsm.deviceId);
        platform.log.debug(`Status from the API is ${JSON.stringify({ DeviceStatus: d.DeviceStatus })}`);

        if (this.fsm.state === 'open' && d.DeviceStatus !== GarageDoorState.Open) {
          this.resetDeviceState(d);
        } else if (this.fsm.state === 'closed' && d.DeviceStatus !== GarageDoorState.Closed) {
          this.resetDeviceState(d);
        } else if (
          this.fsm.state === 'stuck' &&
          (d.DeviceStatus === GarageDoorState.Open || d.DeviceStatus === GarageDoorState.Closed)
        ) {
          this.resetDeviceState(d);
        }
      }
    }, 60_000);
  }

  private resetDeviceState(device: Device) {
    this.fsm.lastTransition = new Date(device.LastOperationTimestamp).getTime();

    switch (device.DeviceStatus) {
      case GarageDoorState.Open:
        this.platform.log.info(
          `Resetting device state to OPEN ${device.DeviceStatus}; FSM ${this.fsm}, ` +
          `Device (${device.DeviceStatus}, ${device.LastOperationTimestamp})`,
        );
        this.fsm.resetOpen();
        break;
      case GarageDoorState.Closed:
        this.platform.log.info(
          `Resetting device state to CLOSED ${device.DeviceStatus}; FSM ${this.fsm}, ` +
          `Device (${device.DeviceStatus}, ${device.LastOperationTimestamp})`,
        );
        this.fsm.resetClosed();
        break;
      default:
        this.platform.log.info(
          `Failed to understand... STUCK ${device.DeviceStatus}; FSM ${this.fsm}, ` +
          `Device (${device.DeviceStatus}, ${device.LastOperationTimestamp})`,
        );
        this.fsm.stuck();
    }
  }

  /**
   * Handle "SET" requests from HomeKit
   */
  async setTargetDoorState(value: CharacteristicValue) {
    this.platform.log.debug(`Set Target Door State -> ${value} (${this.fsm})`);
    try {
      if (value === this.platform.Characteristic.TargetDoorState.OPEN) {
        this.service.setCharacteristic(
          this.platform.Characteristic.CurrentDoorState,
          this.platform.Characteristic.CurrentDoorState.OPENING,
        );
        if (this.fsm.can('open')) {
          await this.fsm.open(); // calls our wrapped client with correct metadata
        } else {
          this.platform.log.warn(`Attempting to transition to OPEN but ${this.fsm}`);
        }
        setTimeout(() => {
          this.service.setCharacteristic(
            this.platform.Characteristic.CurrentDoorState,
            this.platform.Characteristic.CurrentDoorState.OPEN,
          );
          this.platform.log.debug('Transitioned successfully to OPEN');
        }, 12_000);
      } else {
        this.service.setCharacteristic(
          this.platform.Characteristic.CurrentDoorState,
          this.platform.Characteristic.CurrentDoorState.CLOSING,
        );
        if (this.fsm.can('close')) {
          await this.fsm.close(); // calls our wrapped client with correct metadata
        } else {
          this.platform.log.warn(`Attempting to transition to close but ${this.fsm}`);
        }
        setTimeout(() => {
          this.service.setCharacteristic(
            this.platform.Characteristic.CurrentDoorState,
            this.platform.Characteristic.CurrentDoorState.CLOSED,
          );
          this.platform.log.debug('Transitioned successfully to CLOSED');
        }, 12_000);
      }
    } catch (e) {
      this.platform.log.error(`Problem detected attempting to change ${this.fsm} -> `, e);
      this.fsm.stuck();
      this.service.setCharacteristic(
        this.platform.Characteristic.CurrentDoorState,
        this.platform.Characteristic.CurrentDoorState.STOPPED,
      );
    }
  }

  async getTargetDoorState(): Promise<CharacteristicValue> {
    this.platform.log.debug(`Get Target Door State -> ${this.fsm}`);
    switch (this.fsm.state) {
      case 'open':
        return this.platform.Characteristic.TargetDoorState.OPEN;
      case 'closed':
        return this.platform.Characteristic.TargetDoorState.CLOSED;
      default:
        return this.platform.Characteristic.TargetDoorState.CLOSED;
    }
  }

  async getCurrentDoorState(): Promise<CharacteristicValue> {
    this.platform.log.debug(`Get Current Door State -> ${this.fsm}`);
    switch (this.fsm.state) {
      case 'open':
        return this.fsm.isTransitioning()
          ? this.platform.Characteristic.CurrentDoorState.OPENING
          : this.platform.Characteristic.CurrentDoorState.OPEN;
      case 'closed':
        return this.fsm.isTransitioning()
          ? this.platform.Characteristic.CurrentDoorState.CLOSING
          : this.platform.Characteristic.CurrentDoorState.CLOSED;
      default:
        return this.platform.Characteristic.CurrentDoorState.STOPPED;
    }
  }

  async getObstructionDetected(): Promise<CharacteristicValue> {
    this.platform.log.debug('Get Obstruction -> ', this.fsm.toString());
    return this.fsm.state === 'stuck';
  }
}
