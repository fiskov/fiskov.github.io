PRIMARY_SERVICE = 0xFFAA
CHAR_NOTICE = 0xFF00
CHAR_REQ = 0xFF01

// Получение ссылок на элементы UI
let connectButton = document.getElementById('connect');
let connectAndActiveButton = document.getElementById('connectAndActive');
let disconnectButton = document.getElementById('disconnect');
let sendHiButton = document.getElementById('sendHiButton');
let sendActiveButton = document.getElementById('sendActiveButton');
let sendSleepButton = document.getElementById('sendSleepButton');
let sendGetSleepButton = document.getElementById('sendGetSleepButton');

let terminalContainer = document.getElementById('terminal');
let sendForm = document.getElementById('send-form');
let inputField = document.getElementById('input');

let hexTxt = document.getElementById('hexTxt');
let hexUint = document.getElementById('hexUint');

let idCounter = 0;

// Подключение к устройству при нажатии на кнопку Connect
connectButton.addEventListener('click', function() {
  connect();
});
connectAndActiveButton.addEventListener('click', function() {
  console.time("connectTimer")
  connect().
  then(_=> {
    writeToCharacteristic(characteristicCacheReq, strToArr("706869")).
    then( _ => writeToCharacteristic(characteristicCacheReq, strToArr("203C"))
    )
  });
  
});

// Отключение от устройства при нажатии на кнопку Disconnect
disconnectButton.addEventListener('click', function() {
  disconnect();
});
// Послать запрос "hi" на устройство
sendHiButton.addEventListener('click', function() {
  writeToCharacteristic(characteristicCacheReq, strToArr("706869"));
});
// Послать запрос "Active" на устройство
sendActiveButton.addEventListener('click', function() {
  writeToCharacteristic(characteristicCacheReq, strToArr("203C"));
});
// Послать запрос "Sleep" на устройство
sendSleepButton.addEventListener('click', function() {
  writeToCharacteristic(characteristicCacheReq, strToArr("21100E"));
});
// Послать запрос "get Sleep" на устройство
sendGetSleepButton.addEventListener('click', function() {
  writeToCharacteristic(characteristicCacheReq, strToArr("21"));
});

// Обработка события отправки формы
sendForm.addEventListener('submit', function(event) {
  event.preventDefault(); // Предотвратить отправку формы
  send(inputField.value); // Отправить содержимое текстового поля
  inputField.value = '';  // Обнулить текстовое поле
  inputField.focus();     // Вернуть фокус на текстовое поле
});

// Кэш объекта выбранного устройства
let deviceCache = null;
// Кэш объекта сервиса
let serviceCache = null;
// Кэш объекта характеристики
let characteristicCache = null;
let characteristicCacheReq = null;

// Промежуточный буфер для входящих данных
let readBuffer = '';

// Запустить выбор Bluetooth устройства и подключиться к выбранному
function connect() {
  return (deviceCache ? Promise.resolve(deviceCache) :
      requestBluetoothDevice()).
      then(device => connectDeviceAndCacheCharacteristic(device)).
      then(characteristic => startNotifications(characteristic)).
      catch(error => log(error));
}

// Запрос выбора Bluetooth устройства
function requestBluetoothDevice() {
  log('Requesting bluetooth device...');

  return navigator.bluetooth.requestDevice({
    filters: [{services: [PRIMARY_SERVICE]}],
  }).
      then(device => {
        log('"' + device.name + '"' + device.id + '] bluetooth device selected');
        deviceCache = device;
        deviceCache.addEventListener('gattserverdisconnected',
            handleDisconnection);

        return deviceCache;
      });
}

// Обработчик разъединения
function handleDisconnection(event) {
  let device = event.target;

  log('"' + device.name +
      '" bluetooth device disconnected, trying to reconnect...');

  connectDeviceAndCacheCharacteristic(device).
      then(characteristic => startNotifications(characteristic)).
      catch(error => log(error));
}

// Подключение к определенному устройству, получение сервиса и характеристики
function connectDeviceAndCacheCharacteristic(device) {
  if (device.gatt.connected && characteristicCache) {
    return Promise.resolve(characteristicCache);
  }

  log('Connecting to GATT server...');

  return device.gatt.connect().
      then(server => {
        log('GATT server connected, getting service...');

        return server.getPrimaryService(PRIMARY_SERVICE);
      }).
      then(service => {
        log('Service found, getting characteristic req...');
        serviceCache = service

        return service.getCharacteristic(CHAR_REQ);
      }).
      then(characteristic => {
        log('Characteristic found');
        characteristicCacheReq = characteristic;

        return characteristicCacheReq;
      }).
      then(_ => {
        log('Service found, getting characteristic notice...');

        return serviceCache.getCharacteristic(CHAR_NOTICE);
      }).
      then(characteristic => {
        log('Characteristic found');
        characteristicCache = characteristic;

        return characteristicCache;
      });
}

// Включение получения уведомлений об изменении характеристики
function startNotifications(characteristic) {
  log('Starting notifications...');

  return characteristic.startNotifications().
      then(() => {
        log('Notifications started');
        characteristic.addEventListener('characteristicvaluechanged',
            handleCharacteristicValueChanged);
      });
}

function dataViewToHex(view)
{
  let hex = '';
  for (let i = 0; i < view.byteLength; i++) {
    hex += view.getUint8(i).toString(16).padStart(2,'0').toUpperCase() + ' ';
  }  
  return hex
}
function arrayBufferToHex(buffer) { // buffer is an ArrayBuffer
  return [...new Uint8Array(buffer)]
      .map(x => x.toString(16).padStart(2, '0').toUpperCase())
      .join(' ');
}

// Получение данных
function handleCharacteristicValueChanged(event) {
  let view = event.target.value;
  let txt = '';
  let txtUint = '';

  if (view.byteLength == 0)
  {
    receive('<none>');
    return;
  }

  let msg = dataViewToHex(event.target.value) + '<' + view.byteLength.toString(10) + '>';

  if (hexTxt.checked)
  {
    let isTxt = true;

    for (let i = 0; i < view.byteLength; i++)
    {
      b = view.getUint8(i)
      if ((b < 0x20) || (b >= 0x7F))
      {
        isTxt = false;
        break;
      }
    }
    if (isTxt)
    {
      for (let i = 0; i < view.byteLength; i++)
        txt += String.fromCharCode(view.getUint8(i));

      msg = '"' + txt + '" ' + msg;
    }
  }

  if (hexUint.checked && (view.byteLength <= 4))
  {
    let value = 0;

    for (let i = 0; i < view.byteLength; i++)
      value += view.getUint8(i) * (1 << (8*i));

    msg += '=' + value.toString(10);
  }

  receive(msg);
}

// Обработка полученных данных
function receive(data) {
  log(data, 'in');
}

// Вывод в терминал
function log(data, type = '') {
  let id = 'item'+idCounter.toString(10)
  idCounter += 1

  terminalContainer.insertAdjacentHTML('beforeend',
      '<div' + (type ? ' class="' + type + '"' : '') + ' id="'+id+'">' + data + '</div>');
  terminalContainer.scrollTop = document.getElementById(id).offsetTop;
}

// Отключиться от подключенного устройства
function disconnect() {
  if (deviceCache) {
    log('Disconnecting from "' + deviceCache.name + '" bluetooth device...');
    deviceCache.removeEventListener('gattserverdisconnected',
        handleDisconnection);

    if (deviceCache.gatt.connected) {
      deviceCache.gatt.disconnect();
      log('"' + deviceCache.name + '" bluetooth device disconnected');
    }
    else {
      log('"' + deviceCache.name +
          '" bluetooth device is already disconnected');
    }
  }

  if (characteristicCache) {
    characteristicCache.removeEventListener('characteristicvaluechanged',
        handleCharacteristicValueChanged);
    characteristicCache = null;
  }

  deviceCache = null;
}

function strToArr(str) {
  var arr = str.match(/[0-9a-f]{2}/ig); // convert into array of hex pairs
  arr = arr.map(x => parseInt(x, 16)); // convert hex pairs into ints (bytes)
  return (new Uint8Array(arr).buffer);
}

// Отправить данные подключенному устройству
function send(data) {
  data = String(data);

  if (!data || !characteristicCacheReq) {
    return;
  }

  writeToCharacteristic(characteristicCacheReq, strToArr(data));
}

// Записать значение (uint8array) в характеристику
function writeToCharacteristic(characteristic, data) {
  if (!data)
  {
    log("no data", 'err')
    return;
  } 
  if (!characteristicCacheReq) {
    log("no char", 'err')
    return;
  }
  log(arrayBufferToHex(data), 'out');
  return characteristic.writeValueWithResponse(data);
}
