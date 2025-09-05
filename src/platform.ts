import {
  API,
  Categories,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';
import { NexxApiClient } from '@jontg/nexx-garage-sdk';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { NXG200 } from './nxg200';

/**
 * HomebridgePlatform
 * Parses user config and discovers/registers accessories with Homebridge.
 */
export class NexxHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  // cache of restored accessories
  public readonly accessories: PlatformAccessory[] = [];

  public nexxApiClient: NexxApiClient;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug('Finished initializing platform:', this.config.name);
    this.nexxApiClient = new NexxApiClient(config.auth);

    this.api.on('didFinishLaunching', async () => {
      this.log.debug('Executed didFinishLaunching callback');
      await this.discoverDevices();
    });
  }

  /**
   * Invoked when homebridge restores cached accessories at startup.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  /**
   * Discover devices via Nexx API and register them.
   */
  async discoverDevices() {
    const devices = await this.nexxApiClient.getDevices();
    const discoveredDeviceIds: string[] = [];

    // read options
    const includeGate =
      !!(this.config && (this.config as any).options && (this.config as any).options.includeGate);
    const treatGateAsGarage =
      (this.config && (this.config as any).options && (this.config as any).options.treatGateAsGarage) !== false;

    for (const device of devices as any[]) {
      const isGarage =
        device.DeviceType === 'NexxGarage' ||
        ['NXG200', 'NXG300'].includes(device.ProductCode);

      const isGate =
        device.DeviceType === 'NexxGate' ||
        device.ProductCode === 'NXGT1';

      if (!isGarage && !(includeGate && isGate)) {
        // unchanged behavior for other/unknown devices
        this.log.info('Skipping device (unsupported):', JSON.stringify({
          DeviceId: device.DeviceId,
          DeviceType: device.DeviceType,
          ProductCode: device.ProductCode,
          DeviceNickName: device.DeviceNickName,
        }));
        continue;
      }

      // Log the accepted device
      this.log.info('Registering device:', JSON.stringify({
        DeviceId: device.DeviceId,
        DeviceType: device.DeviceType,
        ProductCode: device.ProductCode,
        DeviceNickName: device.DeviceNickName,
      }));

      // Generate a stable UUID per device
      const uuid = this.api.hap.uuid.generate(device.DeviceId);
      discoveredDeviceIds.push(uuid);

      // Try to find existing accessory from cache
      const existingAccessory = this.accessories.find(a => a.UUID === uuid);

      // Decide the HomeKit category. For gates we still use GarageDoorOpener
      // so the UX (Siri / CarPlay) is ideal.
      const category: Categories =
        isGate && treatGateAsGarage
          ? Categories.GARAGE_DOOR_OPENER
          : Categories.GARAGE_DOOR_OPENER; // same for garages

      if (existingAccessory) {
        // Update cached accessory
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
        existingAccessory.context.device = device;
        this.api.updatePlatformAccessories([existingAccessory]);

        new NXG200(this, existingAccessory);
      } else {
        // Create and register new accessory
        this.log.info('Adding new accessory:', device.DeviceNickName);
        const accessory = new this.api.platformAccessory(device.DeviceNickName, uuid, category);

        // Stash the raw device so handlers can use full metadata
        accessory.context.device = device;

        // Create handler (NXG200 works for both garage & gate because
        // we expose the same GarageDoorOpener service)
        new NXG200(this, accessory);

        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }

    // Unregister accessories that are no longer discovered
    for (const accessory of this.accessories) {
      if (discoveredDeviceIds.indexOf(accessory.UUID) === -1) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }
}
