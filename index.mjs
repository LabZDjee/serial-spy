/* jshint esversion: 6 */

import SerialPort from "serialport";
import Regex from "@serialport/parser-regex";

import chalk from "chalk";
import fs from "fs";
import numeral from "numeral";

let configurationFilename;
let helpRequired = false;

process.argv.forEach(arg => {
  const jsonExtRegEx = /\.json$/i;
  if (jsonExtRegEx.test(arg)) {
    configurationFilename = arg;
  }
  switch (arg.toLowerCase()) {
    case "--help":
    case "-h":
      helpRequired = true;
      break;
  }
});

if (helpRequired || configurationFilename === undefined) {
  console.log(`serial-spy <json-configuration-file>
 with <json-configuration-file> being a JSON file (extension .json) made of
  an array composed of object literals with the following props:
   comPort: tty/COM serial port name
   openOptions: an object composed of the following props:
    baudRate (integer), dataBits (int, 5 to 8), parity ("none", "even", "odd")
   color: black, red, green, yellow, blue, magenta, cyan, white, blackBright
    (also: gray, grey), redBright, greenBright, yellowBright, blueBright,
    magentaBright, cyanBright, whiteBright
   bgColor: bgBlack, bgRed, bgGreen, ...
   delimiter: "\\n", ...
   format: hex, ascii, utf8
   stamp: normal, diff, none
   translateCtrl: if "yes" (and not in hex format), \\u000d => \\r, etc
   filters: an optional array of regular expressions which should match
    for data frame to be displayed
   replacements: an optional array of objects with two properties, 'what' a
    match regex to find and replace 'with' a replacement string
 For more details: https://github.com/LabZDjee/serial-spy#readme`);
  process.exit();
}

let configuration;

try {
  configuration = JSON.parse(fs.readFileSync(configurationFilename, "utf-8"));
} catch (e) {
  console.log(chalk.red(e.toString()));
  process.exit();
}

function checkMissingKeysOnParam(param) {
  let missing = [];
  const paramCompulsoryKeys = ["comPort", "openOptions", "color", "bgColor", "delimiter", "format", "stamp", "translateCtrl"];
  const paramOpenOptionCompulsoryKeys = ["baudRate", "dataBits", "parity"];
  const paramReplacementCompulsoryKeys = ["what", "with"];
  paramCompulsoryKeys.forEach(key => {
    if (param[key] === undefined) {
      missing.push(key);
    }
  });
  if (param.openOptions !== undefined) {
    paramOpenOptionCompulsoryKeys.forEach(key => {
      if (param.openOptions[key] === undefined) {
        missing.push(`openOptions.${key}`);
      }
    });
  }
  if (param.replacements !== undefined) {
    param.replacements.forEach((_, index) => {
      paramReplacementCompulsoryKeys.forEach(key => {
        if (param.replacements[index][key] === undefined) {
          missing.push(`replacements[${index}].${key}`);
        }
      });
    });
  }
  return missing;
}

const time0 = Date.now();
let lastStamp;

configuration.forEach((param, index) => {

  const missingKeys = checkMissingKeysOnParam(param);

  if (missingKeys.length > 0) {
    console.log(chalk.red(`Panic with index ${index} of config. file "${configurationFilename}", missing key${missingKeys.length !== 1 ? "s":""}: ${missingKeys.join(", ")}`));
    process.exit();
  }

  try {
    param.regexDelimiter = new RegExp(param.delimiter);
  } catch (e) {
    console.log(chalk.red(`Panic with index ${index} of config. file "${configurationFilename}", param.delimiter is not valid`));
    console.log(chalk.red(` => ${e.toString()}`));
    process.exit();

  }

  if (param.replacements !== undefined) {
    param.replacements.forEach((replacement, index2) => {
      try {
        replacement.whatAsRegExp = new RegExp(replacement.what, "g");
      } catch (e) {
        console.log(chalk.red(`Panic with index ${index} of config. file "${configurationFilename}", replacements[${index2}].what is not a valid`));
        console.log(chalk.red(` => ${e.toString()}`));
        process.exit();
      }
    });
  }

  if (param.filters !== undefined) {
    param.filtersAsRexp = [];
    param.filters.forEach((filter, index2) => {
      try {
        param.filtersAsRexp.push(RegExp(filter));
      } catch (e) {
        console.log(chalk.red(`Panic with index ${index} of config. file "${configurationFilename}", filters[${index2}] is not a valid`));
        console.log(chalk.red(` => ${e.toString()}`));
        process.exit();
      }
    });
  }

  if (typeof param.openOptions.baudRate === "string") {
    param.openOptions.baudRate = parseInt(param.openOptions.baudRate, 10);
  }
  if (typeof param.openOptions.dataBits === "string") {
    param.openOptions.dataBits = parseInt(param.openOptions.dataBits, 10);
  }

  const port = new SerialPort(param.comPort, param.openOptions);

  const parser = port.pipe(new Regex({
    regex: param.regexDelimiter,
    encoding: param.format.toLowerCase() === "hex" ? "ascii" : param.encoding,
  }));

  parser.on('data', (buf) => {

    buf = buf.toString();

    function filtered(str) {
      let result = false;
      if (param.filtersAsRexp !== undefined) {
        result = true;
        for (let i = 0; i < param.filtersAsRexp.length; i++) {
          if (param.filtersAsRexp[i].test(str)) {
            result = false;
            break;
          }
        }
      }
      return result;
    }

    const stamp = (Date.now() - time0) / 1000;

    function toSpaces(str) {
      return str.replace(/./g, " ");
    }

    function numToHexByte(n, width = 2) {
      const hexStr = n.toString(16).toUpperCase();
      let padding = "";
      for (let i = 0; i < width - hexStr.length; i++) {
        padding += "0";
      }
      return `${padding}${hexStr}`;
    }

    function replacements(str) {
      if (param.replacements !== undefined) {
        param.replacements.forEach(replacement => {
          str = str.replace(replacement.whatAsRegExp, replacement.with);
        });
      }
      const ctrlStrList = [
        "\\0", "^a", "^b", "^c", "^d", "^e", "^f", "\\a",
        "\\b", "\\t", "\\n", "\\v", "\\f", "\\r", "^n", "^o",
        "^p", "^q", "^r", "^s", "^t", "^u", "^v", "^w",
        "^x", "^y", "^z", "^[", "^\\", "^]", "^^", "^_"
      ];
      if (param.translateCtrl.toLowerCase() === "yes" && param.format.toLowerCase() !== "hex") {
        const split = str.split("");
        split.forEach((char, index) => {
          const code = char.charCodeAt();
          if (code < 32) {
            split[index] = ctrlStrList[code];
          }
        });
        str = split.join("");
      }
      return str;
    }

    function formatBuf(buf) {
      if (param.format.toLowerCase() !== "hex") {
        return replacements(buf);
      }
      let hexStr = "";
      for (let i = 0; i < buf.length; i++) {
        hexStr += `${numToHexByte(buf.charCodeAt(i))} `;
      }
      return replacements(hexStr.substring(0, hexStr.length - 1));
    }

    const dataToDisplay = formatBuf(buf);
    if (filtered(dataToDisplay)) {
      return;
    }

    if (param.stamp.toLowerCase() !== "none") {
      let formatedStamp;
      if (param.stamp.toLowerCase() === "diff" && lastStamp !== undefined) {
        formatedStamp = `+${numeral(stamp - lastStamp).format("00000,0.000").replace(/^[0,]*/, toSpaces)}`;
      } else {
        formatedStamp = numeral(stamp).format("000000,0.000").replace(/^[0,]*/, toSpaces);
      }
      console.log(chalk `{reset.black.bgWhite ${formatedStamp}>}{reset  }{reset.${param.color}.${param.bgColor} ${dataToDisplay}}`);
    } else {
      console.log(chalk `{reset.${param.color}.${param.bgColor} ${dataToDisplay}}`);
    }
    lastStamp = stamp;
  });

  port.on("open", () => {
    console.log(chalk `{cyan.bold [port ${param.comPort} open]}`);
  });

  port.on("close", () => {
    console.log(chalk `{magenta.bold [port ${param.comPort} closed]}`);
  });

  port.on("error", () => {
    console.log(chalk `{red.bold [port ${param.comPort} in error]}`);
  });
});
