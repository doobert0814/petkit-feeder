
'use strict';

let Service, Characteristic, api;

const fs = require('fs');
const packageConfig = require('./package.json')
const axios = require('axios');
const deasyncPromise = require('deasync-promise');
const event = require('events');
const format = require('string-format');
const dayjs = require('dayjs');
const pollingtoevent = require('polling-to-event');

const default_headers = Object.freeze({
    'X-Client': 'ios(14.5;iPhone12,3)',
    'Accept': '*/*',
    'X-Timezone': '-8.0',
    'Accept-Language': 'en-US;q=1',
    'Accept-Encoding': 'gzip, deflate',
    'X-Api-Version': '7.24.0',
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': 'PETKIT/7.24.0 (iPhone; iOS 14.5; Scale/3.00) ',
    'X-TimezoneId': 'America/Los_Angeles',
    'X-Locale': 'en_US'
})

const support_settings = Object.freeze({
    'manualLock' : 'settings.manualLock',      // 1 for off, 0 for on
    'lightMode' : 'settings.lightMode',
});

const global_urls = Object.freeze({
    'north_america':{
        'owndevices': 'http://api.petkt.com/latest/discovery/device_roster',
        'deviceState': 'http://api.petkt.com/latest/feeder/devicestate?id={}',
        'deviceDetail': 'http://api.petkt.com/latest/feeder/device_detail?id={}',
        'saveDailyFeed': 'http://api.petkt.com/latest/feeder/save_dailyfeed?deviceId={}&day={}&time={}&amount={}',
        'removeDailyFeed': 'http://api.petkt.com/latest/feeder/remove_dailyfeed?deviceId={}&day={}&id=d{}',
        'dailyfeeds': 'http://api.petkt.com/latest/feeder/dailyfeeds?deviceId={}&days={}',
        'restoreDailyFeeds': 'http://api.petkt.com/latest/feeder/restore_dailyfeed?deviceId={}&day={}&id=s{}',
        'disableDailyFeeds': 'http://api.petkt.com/latest/feeder/remove_dailyfeed?deviceId={}&day={}&id=s{}',
        'resetDesiccant': 'http://api.petkt.com/latest/feeder/desiccant_reset?deviceId={}',
        'updateSettings': 'http://api.petkt.com/latest/feeder/update?id={}&kv={}',
    }

});



const min_amount = 0;                   // in meal(same in app)
const max_amount = 30;                  // in meal(same in app)
const min_desiccantLeftDays = 0;        // in day
const max_desiccantLeftDays = 30;       // in day
const min_pollint_interval = 60;        // in second
const max_pollint_interval = 3600;      // in second
const min_fetch_status_interval = 10;   // in second

module.exports = function(homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    api = homebridge;
    homebridge.registerAccessory('homebridge-petkit-feeder-fresh-element', 'petkit_feeder_fresh_element', petkit_feeder_fresh_element_plugin);
}

function getTimestamp() {
    return Math.floor(Date.now() / 1000);
}

function getDataString() {
    return dayjs(new Date()).format('YYYYMMDD');
}

function getConfigValue(original, default_value) {
    return (original !== undefined ? original : default_value);
}

class petkit_feeder_fresh_element_plugin {

    constructor(log, config) {
        this.log = log;
        this.headers = {};
        this.lastUpdateTime = 0;
        this.getDeviceDetailEvent = null;
        this.poolToEventEmitter = null;
        this.storagedConfig = {
            'mealAmount': 3
        };
        this.deviceDetailInfo = {
            'food' : 0,
            'desiccantLeftDays' : 0,
            'manualLock': 0,
            'lightMode': 0,
            'meals': {}
        };

        this.log('begin to initialize petkit feeder fresh element.');


        // location
        if (!config['location'] || !global_urls[config['location']]) {
            this.log.error('wrong value in config.json file: location.');
            return;
        }
        this.location = config['location'];
        this.urls = global_urls[config['location']];

        // http request headers
        if (config['headers'] === undefined) {
            this.log.error('missing field in config.json file: headers.');
            return;
        }
        this.convertHeadersetFormat(config['headers']);
        if (!this.headers) {
            return;
        }

        // device id && device detail info
        this.deviceId = config['deviceId'];
        const devices = this.praseGetDeviceResult(this.dePromise(this.http_getOwnDevice()));
        if (!devices) {
            return;
        } else if (this.deviceId !== undefined && devices != this.deviceId) {
            this.log.warn('found you just ownd one feeder with deviceId: '+ devices);
            this.log.warn('which is not the same with the deviceId you set: '+ this.deviceId);
            this.log.warn('use '+ devices + ' instead of ' + this.deviceId);
            this.deviceId = devices;
        } else {
            this.log('found you just ownd one feeder with deviceId: '+ devices);
            this.deviceId = devices;
        }
        this.storagedConfig = this.readStoragedConfigFromFile();

        // device information settings
        this.name = getConfigValue(config['name'], 'PetkitFeeder');
        this.serialNumber = getConfigValue(config['sn'], 'PetkitFeeder');
        this.firmware = getConfigValue(config['firmware'], getConfigValue(packageConfig['version'], '1.0.0'));
        this.manufacturer = getConfigValue(config['manufacturer'], 'Petkit');
        this.model = getConfigValue(config['model'], 'Petkit feeder fresh element');

        this.autoDeviceInfo = getConfigValue(config['autoDeviceInfo'], false);
        if (this.autoDeviceInfo && this.dePromise(this.http_getDeviceInfo())) {
            this.name = this.deviceDetailInfo['name'] || this.name;
            this.serialNumber = this.deviceDetailInfo['sn'] || this.serialNumber;
            this.firmware = this.deviceDetailInfo['firmware'] || this.firmware;
            this.headers['X-Timezone'] = this.deviceDetailInfo['timezone'] || this.headers['X-Timezone'];
            this.headers['X-TimezoneId'] = this.deviceDetailInfo['locale'] || this.headers['X-Timezone'];
        }
        this.replaceHeadersetWithDefault();

        // meal, same as petkit app unit 1/5 cup, twenty meal most;
        this.mealAmount = getConfigValue(this.storagedConfig['mealAmount'], 9);
        if (this.mealAmount > max_amount) {
            this.log('mealAmount should not greater than ' + max_amount + ', use ' + max_amount + ' instead');
            this.mealAmount = max_amount;
        } else if (this.mealAmount < min_amount) {
            this.log('mealAmount should not less than ' + min_amount + ', use ' + min_amount + ' instead');
            this.mealAmount = min_amount;
        }

        // device desiccant settings
        this.enable_desiccant = getConfigValue(config['enable_desiccant'], false);
        this.enable_autoreset_desiccant = getConfigValue(config['enable_autoreset_desiccant'], false);
        this.alert_desiccant_threshold = getConfigValue(config['alert_desiccant_threshold'], 7);
        this.reset_desiccant_threshold = getConfigValue(config['reset_desiccant_threshold'], 5);

        // polling settings
        this.enable_polling = getConfigValue(config['enable_polling'], true);
        this.polling_interval = getConfigValue(config['polling_interval'], min_pollint_interval);
        if (this.polling_interval > max_pollint_interval) {
            this.log('mealAmount should not greater than ' + max_pollint_interval + ', use ' + max_pollint_interval + ' instead');
            this.mealAmount = max_pollint_interval;
        } else if (this.polling_interval < min_pollint_interval) {
            this.log('mealAmount should not less than ' + min_pollint_interval + ', use ' + min_pollint_interval + ' instead');
            this.mealAmount = min_pollint_interval;
        }

        // service names
        this.service_names = 
        {
            'DropMeal': getConfigValue(config['DropMeal_name'], 'DropMeal'),
            'MealAmount': getConfigValue(config['MealAmount_name'], 'MealAmount'),
            'FoodStorage': getConfigValue(config['FoodStorage_name'], (this.reverse_foodStorage_indicator ? 'FoodStorage_Empty': 'FoodStorage')),
            'DesiccantLevel': getConfigValue(config['DesiccantLevel_name'], 'DesiccantLevel'),
            'ManualLock': getConfigValue(config['ManualLock_name'], 'ManualLock'),
            'LightMode': getConfigValue(config['LightMode_name'], 'LightMode'),
        };

        // other settings
        this.enable_manualLock = getConfigValue(config['enable_manualLock'], false);
        this.enable_lightMode = getConfigValue(config['enable_lightMode'], false);
        this.reverse_foodStorage_indicator = getConfigValue(config['reverse_foodStorage_indicator'], false);
        this.fast_response = getConfigValue(config['fast_response'], false);

        this.log('petkit feeder loaded successfully.');
    }

    getServices() {
        this.log.debug('begin to initialize homebridge service.');
        var services = [];

        var service_name = null;

        // meal drop service
        service_name = this.service_names['DropMeal'];
        this.drop_meal_service = new Service.Switch(service_name, service_name);
        this.drop_meal_service.getCharacteristic(Characteristic.On)
            .on('get', (callback) => callback(null, 0))
            .on('set', this.hb_dropMeal_set.bind(this));
        services.push(this.drop_meal_service);

        // meal amount setting
        service_name = this.service_names['MealAmount'];
        this.meal_amount_service = new Service.Fan(service_name, service_name);
        this.meal_amount_service.getCharacteristic(Characteristic.On)
            .on('get', (callback) => callback(null, this.mealAmount != 0));
        this.meal_amount_service.getCharacteristic(Characteristic.RotationSpeed)
            .on('get', (callback) => callback(null, this.mealAmount))
            .on('set', this.hb_mealAmount_set.bind(this))
            .setProps({
                minValue: min_amount,
                maxValue: max_amount,
                minStep: 1
            });
        services.push(this.meal_amount_service);

        // food storage indicator
        service_name = this.service_names['FoodStorage'];
        this.food_storage_service = new Service.OccupancySensor(service_name, service_name);
        this.food_storage_service.setCharacteristic(Characteristic.OccupancyDetected, this.deviceDetailInfo['food'])
        this.food_storage_service.getCharacteristic(Characteristic.OccupancyDetected)
            .on('get', this.hb_foodStorageStatus_get.bind(this));
        services.push(this.food_storage_service);

        // desiccant left days
        if (this.enable_desiccant) {
            service_name = this.service_names['DesiccantLevel'];
            this.desiccant_level_service = new Service.FilterMaintenance(service_name, service_name);
            this.desiccant_level_service.setCharacteristic(Characteristic.FilterChangeIndication, (this.deviceDetailInfo['desiccantLeftDays'] < this.alert_desiccant_threshold ? 1 : 0));
            this.desiccant_level_service.getCharacteristic(Characteristic.FilterChangeIndication)
                .on('get', this.hb_desiccantIndicator_get.bind(this));
            
            this.desiccant_level_service.setCharacteristic(Characteristic.FilterLifeLevel, this.deviceDetailInfo['desiccantLeftDays']);
            this.desiccant_level_service.getCharacteristic(Characteristic.FilterLifeLevel)
                .on('get', this.hb_desiccantLeftDays_get.bind(this))
                .setProps({
                    minValue: min_desiccantLeftDays,
                    maxValue: max_desiccantLeftDays,
                    minStep: 1
                });
            
            this.desiccant_level_service.getCharacteristic(Characteristic.ResetFilterIndication)
                .on('set', this.hb_desiccantLeftDays_reset.bind(this))
            services.push(this.desiccant_level_service);
        }

        // manualLock setting
        if (this.enable_manualLock) {
            service_name = this.service_names['ManualLock'];
            this.manualLock_service = new Service.Switch(service_name, service_name);
            this.manualLock_service.setCharacteristic(Characteristic.On, this.deviceDetailInfo['manualLock']);
            this.manualLock_service.getCharacteristic(Characteristic.On)
                .on('get', this.hb_manualLockStatus_get.bind(this))
                .on('set', this.hb_manualLockStatus_set.bind(this));
            services.push(this.manualLock_service);
        }

        // lightMode setting
        if (this.enable_lightMode) {
            service_name = this.service_names['LightMode'];
            this.lightMode_service = new Service.Switch(service_name, service_name);
            this.lightMode_service.setCharacteristic(Characteristic.On, this.deviceDetailInfo['manualLock']);
            this.lightMode_service.getCharacteristic(Characteristic.On)
                .on('get', this.hb_lightModeStatus_get.bind(this))
                .on('set', this.hb_lightModeStatus_set.bind(this));
            services.push(this.lightMode_service);
        }

        // divice information
        this.info_service = new Service.AccessoryInformation();
        this.info_service
            .setCharacteristic(Characteristic.Identify, this.deviceId)
            .setCharacteristic(Characteristic.Manufacturer, this.manufacturer)
            .setCharacteristic(Characteristic.Model, this.model)
            .setCharacteristic(Characteristic.SerialNumber, this.serialNumber)
            // infomation below changed from petkit app require a homebridge reboot to take effect.
            .setCharacteristic(Characteristic.Name, this.name)
            .setCharacteristic(Characteristic.FirmwareRevision, this.firmware);
        services.push(this.info_service);

        // polling
        this.setupPolling();

        this.log.debug('homebridge service initialize success.');
        return services;
    }

    readStoragedConfigFromFile(callback = null) {
        var result = {};
        try {
            var parse_rawdata = (rawdata) => {
                result = JSON.parse(rawdata);
                if (result[this.deviceId] !== undefined) {
                    result = result[this.deviceId];
                } else {
                    result = {};
                }
                return result;
            };

            if (this.deviceId) {
                const filePath = api.user.storagePath() + '/petkit_feeder_fresh_element.json';

                if (callback) {
                    if (!fs.existsSync(filePath)) callback({});
                    fs.readFile(filePath, (error, rawdata) => {
                        if (error) {
                            this.log.error('readstoragedConfigFromFile failed: ' + error);
                        } else {
                            result = parse_rawdata(rawdata);
                        }
                    });
                } else {
                    if (!fs.existsSync(filePath)) return {};
                    const rawdata = fs.readFileSync(filePath);
                    result = parse_rawdata(rawdata);
                }
            }
        } catch (error) {
            this.log.error('readstoragedConfigFromFile failed: ' + error);
        } finally {
            if (callback) {
                callback(result);
            } else {
                return result;
            }
        }
    }

    saveStoragedConfigToFile(callback = null) {
        var result = false;
        try {
            if (this.deviceId) {
                const filePath = api.user.storagePath() + '/petkit_feeder_fresh_element.json';
                var data = {};
                data[this.deviceId] = this.storagedConfig;
                const rawdata = JSON.stringify(data);
                if (callback) {
                    fs.writeFile(filePath, rawdata, (err) => {
                        if (!err) {
                            result = true;
                        } else {
                            this.log.error('saveStoragedConfigToFile failed: ' + err);
                        }
                    });
                } else {
                    fs.writeFileSync(filePath, rawdata);
                    result = true;
                }
            }
        } catch (error) {
            this.log.warn('saveStoragedConfigToFile failed: ' + error);
        } finally {
            if (callback) {
                callback(result);
            } else {
                return result;
            }
        }
    }

    setupPolling() {
        if (this.enable_polling) {
            if (this.polling_interval < min_pollint_interval) {
                this.log.warn('polling interval should greater than ' + min_pollint_interval + '(' + min_pollint_interval / 60 +' min), change to ' + min_pollint_interval + '.');
                this.polling_interval = min_pollint_interval;
            } else if (this.polling_interval > max_pollint_interval) {
                this.log.warn('polling interval should less than ' + max_pollint_interval + '(' + max_pollint_interval / 60 +' min), change to ' + max_pollint_interval + '.');
                this.polling_interval = max_pollint_interval;
            }
            const polling_options = {
                longpolling: true,
                interval: this.polling_interval * 1000,
                longpollEventName: 'deviceStatusUpdatePoll'
            };

            setTimeout(() => {
                this.poolToEventEmitter = pollingtoevent((done) => {
                    this.log('polling start...');
                    this.http_getDeviceDetailStatus()
                    .then((result) => {
                        done(null, result);
                        this.log('polling end...');
                    }).catch((error) => {});
                }, polling_options);
    
                this.poolToEventEmitter.on('deviceStatusUpdatePoll', (result) => {
                    this.uploadStatusToHomebridge();
                });
            }, this.polling_interval * 1000)
        }
    }

    dePromise(promise) {
        var result = undefined;
        try {
            result = deasyncPromise(promise);
        } catch(err) {
            this.log('dePromise error: ' + err);
        } finally {
            return result;
        }
    }
    
    convertHeadersetFormat(config_headers) {
        if (!config_headers) {
            return false;
        }

        config_headers.forEach((header, index) => {
            this.headers[header.key] = header.value;
        });

        if (this.headers['X-Session'] === undefined) {
            this.log.error('missing field in config.json file: headers.X-Session.');
            return false;
        }

        if (this.headers['X-Session'] !== this.headers['F-Session']) {
            this.log.debug('header set X-Session should equal to header set F-Session, replace F-Session.');
            this.headers['F-Session'] = this.headers['X-Session'];
        }

        return true;
    }

    replaceHeadersetWithDefault() {
        Object.keys(default_headers).forEach((key) => {
            if (this.headers[key] === undefined) {
                this.log.debug('missing header set: "' + key + '", using "' + default_headers[key] + '" instead.');
                this.headers[key] = default_headers[key];
            }
        });
    }

    praseGetDeviceResult(jsonObj) {
        if (!jsonObj) {
            this.log.error('praseGetDeviceResult error: jsonObj is nothing.');
            return false;
        }
        const jsonStr = JSON.stringify(jsonObj);
        this.log.debug(jsonStr);

        if (jsonObj.hasOwnProperty('error')) {
            this.log.error('server reply an error: ' + JSON.stringify(jsonObj));
            this.log.error('you may need to check your X-Session and other header configure');
            return false;
        }

        if (!jsonObj.hasOwnProperty('result')) {
            this.log.error('JSON.parse error with:' + jsonStr);
            return false;
        }

        if (!jsonObj.result.hasOwnProperty('devices')) {
            this.log.error('JSON.parse error with:' + jsonStr);
            return false;
        }

        if (jsonObj.result.devices.length === 0) {
            this.log.error('seems you\'re not owned a device.');
            return false;
        }

        var devices = [];
        jsonObj.result.devices.forEach((item, index) => {
            if (item.type == 'Feeder' && item.data) {
                devices.push(item.data);
            }
        });


        if (devices.length === 0) {
            this.log.error('seems you does not owned a Petkit feeder, this plugin only works for Petkit feeder, sorry.');
            return false;
        } else if (devices.length === 1) {
            this.log.debug(JSON.stringify(devices[0]));
            return devices[0].id;
        } else {
            let match_device = devices.find(device => device.id == this.deviceId);
            if (undefined === match_device) {
                const devicesIds = devices.map((device) => {
                    return { 'id': device.id, 'name': device.name };
                });
                this.log.error('seems that you ownd more than one feeder, but the device id you set is not here.');
                this.log.error('do you mean one of this: ' + JSON.stringify(devicesIds));
                return false;
            }
            return match_device.id;
        }
    }

    praseGetDeviceDetailInfo(jsonObj) {
        if (jsonObj === undefined) {
            this.log.error('praseGetDeviceDetailInfo error: jsonObj is nothing.');
            return false;
        }
        const jsonStr = JSON.stringify(jsonObj);
        this.log.debug(jsonStr);

        if (jsonObj.hasOwnProperty('error')) {
            this.log.error('server reply an error: ' + jsonStr);
            this.log.error('you may need to check your X-Session and other header configure');
            return false;
        }

        if (this.deviceDetailInfo['name'] === undefined && jsonObj['name'] !== undefined)
            this.deviceDetailInfo['name'] = jsonObj['name'];

        if (this.deviceDetailInfo['sn'] === undefined && jsonObj['sn'] !== undefined)
            this.deviceDetailInfo['sn'] = jsonObj['sn'];
        
        if (this.deviceDetailInfo['firmware'] === undefined && jsonObj['firmware'] !== undefined)
            this.deviceDetailInfo['firmware'] = jsonObj['firmware'];
        
        if (this.deviceDetailInfo['timezone'] === undefined && jsonObj['timezone'] !== undefined)
            this.deviceDetailInfo['timezone'] = jsonObj['timezone'];
        
        if (this.deviceDetailInfo['locale'] === undefined && jsonObj['locale'] !== undefined)
            this.deviceDetailInfo['locale'] = jsonObj['locale'];

        if (jsonObj['state']) {
            const state = jsonObj['state'];

            // 1 for statue ok, 0 for empty
            if (state['food'] !== undefined) this.deviceDetailInfo['food'] = state['food'] ? 1 : 0;
            this.log.debug('device food storage status is: ' + (this.deviceDetailInfo['food'] ? 'Ok' : 'Empty'));

            if (state['desiccantLeftDays'] !== undefined) this.deviceDetailInfo['desiccantLeftDays'] = state['desiccantLeftDays'];
            this.log.debug('device desiccant remain: ' + (this.deviceDetailInfo['desiccantLeftDays'] + ' day(s)'));
        }
        
        if (jsonObj['settings']) {
            const settings = jsonObj['settings'];

            // on for off, off for on, same behavior with Petkit app.
            if (settings['manualLock'] !== undefined) this.deviceDetailInfo['manualLock'] = settings['manualLock'] ? 0 : 1;
            this.log.debug('device manual lock status is: ' + (this.deviceDetailInfo['manualLock'] ? 'locked' : 'unlocked'));

            // 1 for lignt on, 0 for light off
            if (settings['lightMode'] !== undefined) this.deviceDetailInfo['lightMode'] = settings['lightMode'] ? 1 : 0;
            this.log.debug('device light status is: ' + (this.deviceDetailInfo['lightMode'] ? 'on' : 'off'));
        }

        return true;
    }

    praseUpdateDeviceSettingsResult(jsonObj) {
        if (!jsonObj) {
            this.log.error('praseUpdateDeviceSettingsResult error: jsonObj is nothing.');
            return false;
        }
        const jsonStr = JSON.stringify(jsonObj);
        this.log.debug(jsonStr);

        if (jsonObj.hasOwnProperty('error')) {
            this.log.error('server reply an error: ' + jsonStr);
            this.log.error('you may need to check your X-Session and other header configure');
            return false;
        }

        if (!jsonObj.hasOwnProperty('result')) {
            this.log.error('JSON.parse error with:' + jsonStr);
            return false;
        }

        return (jsonObj.result == 'success');
    }

    praseSaveDailyFeedResult(jsonObj) {
        if (!jsonObj) {
            this.log.error('praseSaveDailyFeedResult error: jsonObj is nothing.');
            return false;
        }
        const jsonStr = JSON.stringify(jsonObj);
        this.log.debug(jsonStr);

        if (jsonObj.hasOwnProperty('error')) {
            this.log.error('server reply an error: ' + jsonStr);
            this.log.error('you may need to check your X-Session and other header configure');
            return false;
        }

        if (!jsonObj.hasOwnProperty('result')) {
            this.log.error('JSON.parse error with:' + jsonStr);
            return false;
        }

        if (jsonObj.result.isExecuted == 1) {
            return true;
        }

        return false;
    }

    notifyHomebridgeInfoUpdated() {
        try {
            // if desiccantLeftDays less than {reset_desiccant_threshold} day, auto reset it.
            if (this.enable_desiccant) {
                if (this.enable_autoreset_desiccant) {
                    if (this.deviceDetailInfo.desiccantLeftDays < this.reset_desiccant_threshold) {
                        this.log.debug('desiccant only ' + this.deviceDetailInfo.desiccantLeftDays + 'days left, reset it.');
                        this.hb_desiccantLeftDays_reset(null);
                    } else {
                        this.log.debug('desiccant has '+ this.deviceDetailInfo.desiccantLeftDays +' days left, no need to reset.');
                    }
                } else {
                    this.log.debug('desiccant auto reset function is disabled.');
                }
            }
        } catch(err) {
            this.log('notifyHomebridgeInfoUpdated error: ' + err);
        } finally {

        }
    }

    http_post(url) {
        const options = {
            url: url,
            method: 'POST',
            headers: this.headers
        };
        return new Promise((resolve) => {
            var result = false;
            axios.request(options)
                .then((response) => {
                    if (response.status != 200) {
                        const error = 'post request success, but received a invalid response code: ' + response.status;
                        this.log.error(error);
                    } else {
                        this.log.debug('post request success')
                        result = response.data;
                    }
                })
                .catch((error) => {
                    this.log.error('post request failed: ' + error);
                })
                .then(() => {
                    resolve(result);
                });
        });
    }

    http_getDeviceInfo() {
        var result = false;
        return new Promise((resolve) => {
            this.http_post(format(this.urls.deviceDetail, this.deviceId))
                .then((data) => {
                    if (data) {
                        if (this.praseGetDeviceDetailInfo(data['result'])) {
                            this.log.debug('successfully retrieved device infomation from server.');
                            result = true;
                        }
                    }
                })
                .catch((error) => {
                    this.log.error("http_getDeviceInfo failed: " + error);
                })
                .then(() => {
                    resolve(result);
                });
        });
    }

    http_getDeviceDailyFeeds() {
        var result = false;
        return new Promise((resolve) => {
            const date = getDataString();
            this.http_post(format(this.urls.dailyfeeds, this.deviceId, date))
                .then((data) => {
                    if (data && data['result']) {
                        this.deviceDetailInfo['meals'] = data['result'];
                        this.log.debug('successfully retrieved meals infomation from server.');
                        result = true;
                    }
                })
                .catch((error) => {
                    this.log.error("http_getDeviceDailyFeeds failed: " + error);
                })
                .then(() => {
                    resolve(result);
                });
        });
    }

    http_getOwnDevice() {
        return this.http_post(this.urls.owndevices);
    }

    http_getDeviceState() {
        // {
        //     "result": {
        //         "batteryPower":4,"batteryStatus":0,"desiccantLeftDays":6,
        //         "errorPriority":0,"feeding":0,"food":1,"ota":0,"overall":1,
        //         "pim":1,"runtime":49677,"wifi":{
        //             "bssid":"xxxxxxxxxxxx","rsq":-37,"ssid":"xxxxxxxxxx"
        //         }
        //     }
        // }
        return this.http_post(format(this.urls.deviceState, this.deviceId));
    }

    http_getDeviceDetailStatus() {
        return new Promise((resolve) => {
            const currentTimestamp = getTimestamp();
            var getDeviceDetailResult = {deviceInfo:false};
            if (currentTimestamp - this.lastUpdateTime > min_fetch_status_interval &&
                this.getDeviceDetailEvent === null) {
                this.getDeviceDetailEvent = new event.EventEmitter();
                this.getDeviceDetailEvent.setMaxListeners(0);
                Promise.all([
                    this.http_getDeviceInfo(),
                    // this.http_getDeviceDailyFeeds()
                ]).then((results) => {
                    getDeviceDetailResult.deviceInfo = results[0];  // device info
                    // getDeviceDetailResult.meals = results[1];    // meals info
                })
                .catch((error) => {
                    this.log.error("http_getDeviceDetail failed: " + error);
                })
                .then(() => {
                    this.lastUpdateTime = currentTimestamp;
                    this.getDeviceDetailEvent.emit('finished', getDeviceDetailResult);
                    this.getDeviceDetailEvent = null;
                    resolve(getDeviceDetailResult);
                    setTimeout(this.notifyHomebridgeInfoUpdated.bind(this), 200);
                });
            } else {
                this.log.debug('too close to last update time, pass');
                resolve(false);
            }
        });
    }

    // date：20200920、time: 68400(-1 stand for current)、amount in app unit，1 for 5g, 10 is max(50g)
    async http_saveDailyFeed(amount, time) {
        const date = getDataString();
        return await this.http_post(format(this.urls.saveDailyFeed, this.deviceId, date, time, amount * 20));
    }

    // key see support_settings.
    async http_updateDeviceSettings(key, value) {
        var data = {};
        if (support_settings[key]) {
            data[support_settings[key]] = value;
            return await this.http_post(format(this.urls.updateSettings, this.deviceId, JSON.stringify(data)));
        } else {
            this.log.warn('unsupport setting: ' + key);
            return false;
        }
    }

    async http_resetDesiccant() {
        return await this.http_post(format(this.urls.resetDesiccant, this.deviceId));
    }
    
    uploadStatusToHomebridge() {
        var status = (this.reverse_foodStorage_indicator ? !this.deviceDetailInfo['food'] : this.deviceDetailInfo['food']);
        this.food_storage_service.setCharacteristic(Characteristic.OccupancyDetected, status);

        if (this.enable_desiccant) {
            status = this.deviceDetailInfo['desiccantLeftDays'] < this.alert_desiccant_threshold ? 
                Characteristic.FilterChangeIndication.CHANGE_FILTER :
                Characteristic.FilterChangeIndication.FILTER_OK;
            this.desiccant_level_service.setCharacteristic(Characteristic.FilterChangeIndication, status);
        }
    }

    updataDeviceDetail() {
        return new Promise((resolve) => {
            this.http_getDeviceDetailStatus()
                .then((result) => {
                    if (result) this.uploadStatusToHomebridge();
                })
                .catch((error) => {
                    this.log.error("updataDeviceDetail failed: " + error);
                })
                .then(resolve);
        });
    }

    waitForSignal(sig, callback) {
        if (sig) {
            const callbackHandler = (results) => {
                callback(results);
                sig.removeListener('finished', callbackHandler);
            }
            sig.addListener('finished', callbackHandler);
            return true;
        }
        return false;
    }

    async hb_handle_get(caller, callback) {
        this.log.debug('hb_handle_get: ' + caller);
        if (!this.waitForSignal(this.getDeviceDetailEvent, callback)) {
            this.updataDeviceDetail()
                .then(callback)
                .catch((error) => {
                    this.log.error(caller + ' error: ' + error);
                })
                .then(() => {});
        }
    }

    hb_handle_set_deviceSettings(settingName, status, callback = null) {
        this.log.debug('set ' + settingName + ' to: ' + status);
        var result = false;
        this.http_updateDeviceSettings(settingName, status)
            .then((data) => {
                if (!data) {
                    this.log.error('failed to commuciate with server.');
                } else if (this.praseUpdateDeviceSettingsResult(data)) {
                    result = true;
                    this.deviceDetailInfo[settingName] = status;
                }
            }).catch((error) => {
                this.log.error(error);
            }).then(() => {
                if (callback) callback(result);
                if (result) {
                    this.log('set ' + settingName + ' to: ' + status + ', success');
                } else {
                    this.log.warn('set ' + settingName + ' to: ' + status + ', failed');
                }
                this.updataDeviceDetail();
            });
    }

    hb_mealAmount_set(value, callback) {
        if (this.fast_response) callback(null);
        this.mealAmount = value;
        this.storagedConfig['mealAmount'] = value;
        this.log('set meal amount to ' + value);
        this.saveStoragedConfigToFile((this.fast_response ? null : callback));
    }

    hb_dropMeal_set(value, callback) {
        if (this.fast_response) callback(null);
        this.log.debug('hb_dropMeal_set');
        if (value) {
            if (this.mealAmount) {
                this.log('drop food:' + this.mealAmount + ' meal(s)');

                var result = false;
                this.http_saveDailyFeed(this.mealAmount, -1)
                    .then((data) => {
                        if (!data) {
                            this.log.error('failed to commuciate with server.');
                        } else {
                            result = this.praseSaveDailyFeedResult(data);
                            this.log('food drop result: ' + result ? 'success' : 'failed');
                        }
                    })
                    .catch((error) => {
                        this.log.error('food drop failed: ' + error);
                    })
                    .then(() => {
                        if (!this.fast_response) callback(null);
                    });
            } else {
                this.log('drop food with zero amount, pass.');
            }
            
            setTimeout(() => {
                this.drop_meal_service.setCharacteristic(Characteristic.On, false);
            }, 200);
        }
        this.updataDeviceDetail();
    }

    hb_desiccantIndicator_get(callback) {
        this.hb_handle_get('hb_desiccantIndicator_get', (results) => {
            const status = (this.deviceDetailInfo['desiccantLeftDays'] < this.alert_desiccant_threshold ? 1 : 0);
            callback(null, status);
        });
    }

    hb_desiccantLeftDays_get(callback) {
        this.hb_handle_get('hb_desiccantLeftDays_get', (results) => {
            callback(null, this.deviceDetailInfo['desiccantLeftDays']);
        });
    }

    // reset Desiccant Left Days 
    hb_desiccantLeftDays_reset(callback) {
        if (this.fast_response && callback) {callback(null);}
        this.log.debug('hb_desiccantLeftDays_reset');
        this.http_resetDesiccant()
            .then((data) => {
                if (data && data['result']) {
                    this.deviceDetailInfo['desiccantLeftDays'] = data['result'];
                    this.log('reset desiccant left days success, left days reset to ' + data['result'] + ' days');
                } else {
                    this.log('reset desiccant left days with a unrecognized return.');
                }
            })
            .catch((error) => {
                this.log.error('reset desiccant left days failed: ' + error);
            })
            .then(() => {
                if (!this.fast_response && callback) callback(null);
            });
    }

    hb_foodStorageStatus_get(callback) {
        this.hb_handle_get('hb_foodStorageStatus_get', (results) => {
            callback(null, (this.reverse_foodStorage_indicator ? !this.deviceDetailInfo['food'] : this.deviceDetailInfo['food']));
        });
    }

    hb_manualLockStatus_get(callback) {
        this.hb_handle_get('hb_manualLockStatus_get', (results) => {
            callback(null, this.deviceDetailInfo['manualLock']);
        });
    }

    hb_manualLockStatus_set(value, callback) {
        if (this.fast_response) callback(null);
        this.hb_handle_set_deviceSettings('manualLock', (value ? 0 : 1), (result) => {
            if (!this.fast_response) callback(null);
        });
    }

    hb_lightModeStatus_get(callback) {
        this.hb_handle_get('hb_lightModeStatus_get', (results) => {
            const status = this.deviceDetailInfo['lightMode'];
            callback(null, status);
        });
    }

    hb_lightModeStatus_set(value, callback) {
        if (this.fast_response) callback(null);
        this.hb_handle_set_deviceSettings('lightMode', value, (result) => {
            if (!this.fast_response) callback(null);
        });
    }
}
