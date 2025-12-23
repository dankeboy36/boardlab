// import { Port } from 'ardunno-cli/api'
// import { AttachedBoardListItem } from '../../../cli/arduino';

// const nano33bleMissingPlatform: BoardListItem = BoardListItem.fromPartial({
//     name: 'Arduino Nano 33 BLE',
//     platform: {
//         id: 'arduino:mbed_nano',
//         latest: '3.4.1',
//         name: 'Arduino Mbed OS Nano Boards',
//         maintainer: 'Arduino',
//         website: 'http://www.arduino.cc/',
//         email: 'packages@arduino.cc',
//     },
// });

// const mkr1000: BoardListItem = BoardListItem.fromPartial({
//     name: 'Arduino MKR1000',
//     fqbn: 'arduino:samd:mkr1000',
//     platform: {
//         id: 'arduino:samd',
//         installed: '1.8.13',
//         latest: '1.8.13',
//         name: 'Arduino SAMD Boards (32-bits ARM Cortex-M0+)',
//         maintainer: 'Arduino',
//         website: 'http://www.arduino.cc/',
//         email: 'packages@arduino.cc',
//     },
// });

// const mkr1000Wifi: Port = Port.fromPartial({
//   address: '192.168.0.102',
//   label: 'Arduino at 192.168.0.102',
//   protocol: 'network',
//   protocolLabel: 'Network Port',
//   properties: {
//     '.': 'mkr1000',
//     auth_upload: 'yes',
//     board: 'mkr1000',
//     hostname: 'Arduino.local.',
//     port: '65280',
//     ssh_upload: 'no',
//     tcp_check: 'no',
//   },
// })

// const mkr1000Serial: Port = Port.fromPartial({
//   address: '/dev/cu.usbmodem14101',
//   label: '/dev/cu.usbmodem14101',
//   protocol: 'serial',
//   protocolLabel: 'Serial Port (USB)',
//   properties: {
//     pid: '0x804E',
//     serialNumber: '94A3397C5150435437202020FF150838',
//     vid: '0x2341',
//   },
// })

// const mkr1000AttachedWifi: AttachedBoardListItem = { ...mkr1000, port: mkr1000Wifi };
// const mkr1000AttachedSerial: AttachedBoardListItem = { ...mkr1000, port: mkr1000Serial };

// suite('toBoardBoardItems', () => {
//     test('same board attached twice on different ports', () => {
//         const items = toBoardQuickPickItems(
//             [],
//             [],
//             [mkr1000AttachedSerial, mkr1000AttachedWifi],
//             [nano33bleMissingPlatform, mkr1000],
//         ) as (vscode.QuickPickItem & { data?: unknown })[];
//         assert.equal(items.length, 5);

//         assert.equal(items[0].data, undefined);
//         assert.equal(items[0].kind, vscode.QuickPickItemKind.Separator);

//         assert.notEqual(items[1].data, undefined);
//         assert.deepEqual((<AttachedBoardListItem>items[1].data).port, mkr1000Serial);
//         assert.equal((<AttachedBoardListItem>items[1].data).fqbn, mkr1000.fqbn);
//         assert.notEqual(items[1].description, undefined); // installed platform
//         assert.notEqual(items[1].detail, undefined); // attached

//         assert.notEqual(items[2].data, undefined);
//         assert.deepEqual((<AttachedBoardListItem>items[2].data).port, mkr1000Wifi);
//         assert.equal((<AttachedBoardListItem>items[2].data).fqbn, mkr1000.fqbn);
//         assert.notEqual(items[2].description, undefined); // installed platform
//         assert.notEqual(items[2].detail, undefined); // attached

//         assert.equal(items[3].data, undefined);
//         assert.equal(items[3].kind, vscode.QuickPickItemKind.Separator);

//         assert.notEqual(items[4].data, undefined);
//         assert.equal((<AttachedBoardListItem>items[4].data).fqbn, nano33bleMissingPlatform.fqbn);
//         assert.equal(items[4].description, undefined); // not installed platform
//         assert.equal(items[4].detail, undefined); // not attached
//     });

//     test('no items when search result boards is an empty array', () => {
//         const items = toBoardQuickPickItems([], [], [mkr1000AttachedSerial, mkr1000AttachedWifi], []);
//         assert.equal(items.length, 0);
//     });
// });
