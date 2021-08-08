/* jshint esversion: 6 */

import SerialPort from "serialport";
import Regex from "@serialport/parser-regex";

import chalk from "chalk";
import fs from "fs";
import numeral from "numeral";

let configurationFilename;
let htmlDataFilename;
let textDataFilename;
let helpRequired = false;

process.argv.forEach(arg => {
  const jsonExtRegEx = /\.json$/i;
  if (jsonExtRegEx.test(arg)) {
    configurationFilename = arg;
  }
  const htmlExtRegEx = /\.html?$/i;
  if (htmlExtRegEx.test(arg)) {
    htmlDataFilename = arg;
  }
  const textExtRegEx = /\.te?xt?$/i;
  if (textExtRegEx.test(arg)) {
    textDataFilename = arg;
  }
  switch (arg.toLowerCase()) {
    case "--help":
    case "-h":
      helpRequired = true;
      break;
  }
});

if (helpRequired || configurationFilename === undefined) {
  console.log(`serial-spy <json-configuration-file> [<log-file>.txt] [<log-file>.html]
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
   stamp: normal, diff, time, none
   translateCtrl: if "yes" (and not in hex format), \\u000d => \\r, etc
   filters: an optional array of regular expressions which should match
    for data frame to be displayed
   replacements: an optional array of objects with two properties, 'what' a
    match regex to find and replace 'with' a replacement string
 log-file are optional file streams which record what is displayed in plain text or html
 For more details: https://github.com/LabZDjee/serial-spy#readme`);
  process.exit();
}

let configuration;

const color2HtmlColor = {
  "black": "black",
  "red": "red",
  "green": "green",
  "yellow": "yellow",
  "blue": "blue",
  "magenta": "violet",
  "cyan": "cyan",
  "white": "ghostwhite",
  "blackBright": "gray",
  "gray": "gray",
  "grey": "gray",
  "redBright": "red",
  "greenBright": "lightgreen",
  "yellowBright": "lightyellow",
  "blueBright": "lightskyblue",
  "magentaBright": "magenta",
  "cyanBright": "lightcyan",
  "whiteBright": "white"
};
const bgColor2HtmlColor = {
  "bgBlack": "black",
  "bgRed": "red",
  "bgGreen": "green",
  "bgYellow": "yellow",
  "bgBlue": "blue",
  "bgMagenta": "violet",
  "bgCyan": "cyan",
  "bgWhite": "ghostwhite",
  "bgBlackBright": "gray",
  "bgGray": "gray",
  "bgGrey": "gray",
  "bgRedBright": "red",
  "bgGreenBright": "lightgreen",
  "bgYellowBright": "lightyellow",
  "bgBlueBright": "lightskyblue",
  "bgMagentaBright": "magenta",
  "bgCyanBright": "lightcyan",
  "bgWhiteBright": "white"
};

const ctrlStrList = [
  "\\0", "^a", "^b", "^c", "^d", "^e", "^f", "\\a",
  "\\b", "\\t", "\\n", "\\v", "\\f", "\\r", "^n", "^o",
  "^p", "^q", "^r", "^s", "^t", "^u", "^v", "^w",
  "^x", "^y", "^z", "^[", "^\\", "^]", "^^", "^_"
];

function expandControlCharacters(str) {
  const split = str.split("");
  split.forEach((char, index) => {
    const code = char.charCodeAt();
    if (code < 32) {
      split[index] = ctrlStrList[code];
    }
  });
  return split.join("");
}

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
let textDataFileStream;
let htmlDataFileStream;

const title = `Serial Spy Started on ${Date().toString()}`;

if (textDataFilename !== undefined) {
  try {
    const fd = fs.openSync(textDataFilename, "w");
    textDataFileStream = fs.createWriteStream(textDataFilename, {
      fd
    });
    console.log(`Created write stream to ${textDataFilename}`);
  } catch (e) {
    textDataFileStream = undefined;
    console.log(chalk.red(e.toString()));
    closeHtmlFile();
  }
}

function addToTextFile(str, lf = true) {
  if (textDataFileStream !== undefined) {
    textDataFileStream.write(`${str}${lf?"\n":""}`);
  }
}

function closeTextFile(str = null, lf = true) {
  if (textDataFileStream !== undefined) {
    if (str === null) {
      str = "";
      lf = false;
    }
    textDataFileStream.end(`${str}${lf?"\n":""}`, () => {
      console.log(`Write in ${textDataFilename} completed`);
      textDataFileStream = undefined;
      if (htmlDataFileStream === null) {
        process.exit();
      }
    });
  } else if (htmlDataFileStream === undefined) {
    process.exit();
  }
}

if (htmlDataFilename !== undefined) {
  try {
    const fd = fs.openSync(htmlDataFilename, "w");
    htmlDataFileStream = fs.createWriteStream(htmlDataFilename, {
      fd
    });
    console.log(`Created write stream to ${htmlDataFilename}`);
  } catch (e) {
    console.log(chalk.red(e.toString()));
    htmlDataFileStream = undefined;
    closeTextFile();
  }
}

function addToHtmlFile(str, lf = true) {
  if (htmlDataFileStream !== undefined) {
    htmlDataFileStream.write(`${str}${lf?"\n":""}`);
  }
}

function closeHtmlFile(str) {
  if (htmlDataFileStream !== undefined) {
    const closingString = `${str!==undefined?str+"\n":""}</pre>
</body>
</html>
`;
    htmlDataFileStream.end(closingString, () => {
      console.log(`Write in ${htmlDataFilename} completed`);
      htmlDataFileStream = undefined;
      if (textDataFileStream === undefined) {
        process.exit();
      }
    });
  } else if (textDataFileStream === undefined) {
    process.exit();
  }
}

function htmlPrelude() {
  let prelude = `<!DOCTYPE html>
<html>
<head>
<title>${title}</title>
<style>
 .defColors {background-color: black; color: lightgrey}
 .stamp {background-color: lightgrey; color: black}
 .open {color: cyan}
 .closed {color: magenta}
 .error {color: red}`;
  configuration.forEach((param, index) => {
    prelude += `.color${index+1} {background-color: ${bgColor2HtmlColor[param.bgColor]}; color: ${color2HtmlColor[param.color]}}\n`;
  });
  prelude += `</style>
</head>
<body class="defColors">
<pre>
${title}`;
  return prelude;
}

addToTextFile(title);
addToHtmlFile(htmlPrelude());

function panic(panicMsg) {
  console.log(chalk.red(panicMsg));
  closeTextFile(panicMsg);
  closeHtmlFile(`<span class="error">${panicMsg}</span>`);
}

let inPanic = false;

configuration.forEach((param, index) => {

  if (inPanic) {
    return;
  }

  const missingKeys = checkMissingKeysOnParam(param);

  param.prompt = String.fromCharCode(index + 65);
  param.number = index + 1;

  if (missingKeys.length > 0) {
    const panicMsg = `Panic with index ${index} of config. file "${configurationFilename}", missing key${missingKeys.length !== 1 ? "s":""}: ${missingKeys.join(", ")}`;
    panic(panicMsg);
    inPanic = true;
    return;
  }

  try {
    param.regexDelimiter = new RegExp(param.delimiter);
  } catch (e) {
    const errorMsg = `Panic with index ${index} of config. file "${configurationFilename}", param.delimiter is not valid
  => ${e.toString()}`;
    panic(errorMsg);
    inPanic = true;
    return;
  }

  if (param.replacements !== undefined) {
    param.replacements.forEach((replacement, index2) => {
      try {
        replacement.whatAsRegExp = new RegExp(replacement.what, "g");
      } catch (e) {
        const errorMsg = `Panic with index ${index} of config. file "${configurationFilename}", replacements[${index2}].what is not a valid
  => ${e.toString()}`;
        panic(errorMsg);
        inPanic = true;
        return;
      }
    });
  }

  if (inPanic) {
    console.log("inPanic");
    return;
  }

  if (param.filters !== undefined) {
    param.filtersAsRexp = [];
    param.filters.forEach((filter, index2) => {
      try {
        param.filtersAsRexp.push(RegExp(filter));
      } catch (e) {
        const errorMsg = `Panic with index ${index} of config. file "${configurationFilename}", filters[${index2}] is not a valid regexp
 => ${e.toString()}`;
        panic(errorMsg);
        inPanic = true;
        return;
      }
    });
  }

  if (inPanic) {
    return;
  }

  if (typeof param.openOptions.baudRate === "string") {
    param.openOptions.baudRate = parseInt(param.openOptions.baudRate, 10);
  }
  if (typeof param.openOptions.dataBits === "string") {
    param.openOptions.dataBits = parseInt(param.openOptions.dataBits, 10);
  }
});

if (!inPanic) {
  configuration.forEach((param, index) => {
    const port = new SerialPort(param.comPort, param.openOptions);

    const parser = port.pipe(new Regex({
      regex: param.regexDelimiter,
      encoding: param.format.toLowerCase() === "hex" ? "ascii" : param.encoding,
    }));

    let paramDetails = `${param.prompt}: ${param.comPort}-${param.openOptions.baudRate}-${param.openOptions.dataBits}-${param.openOptions.parity.substring(0, 1)}-${param.format}
 delimiter: "${expandControlCharacters(param.delimiter)}"\n`;
    if (param.filters !== undefined) {
      paramDetails += " filters:\n";
      param.filters.forEach(filter => {
        paramDetails += `  "${expandControlCharacters(filter)}"\n`;
      });
    }
    if (param.replacements !== undefined) {
      paramDetails += " replacements:\n";
      param.replacements.forEach(replacement => {
        paramDetails += `  "${expandControlCharacters(replacement.what)}" => "${expandControlCharacters(replacement.with)}"\n`;
      });
    }
    addToTextFile(paramDetails);
    addToHtmlFile(paramDetails);

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
        if (param.translateCtrl.toLowerCase() === "yes" && param.format.toLowerCase() !== "hex") {
          str = expandControlCharacters(str);
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
        if (param.filterPostRemanenceCount > 0) {
          param.filterPostRemanenceCount--;
        } else {
          return;
        }
      } else {
        param.filterPostRemanenceCount = param.filterPostRemanence;
      }

      if (param.stamp.toLowerCase() !== "none") {
        let formatedStamp;
        if (param.stamp.toLowerCase() === "time") {
          const d = new Date();
          const f = v => numeral(v).format("00");
          formatedStamp = `${f(d.getMonth()+1)}/${f(d.getDate())}-${f(d.getHours())}:${f(d.getMinutes())}:`;
          formatedStamp += `${f(d.getSeconds())}.${numeral(d.getMilliseconds()).format("0000")}`;
        } else if (param.stamp.toLowerCase() === "diff" && lastStamp !== undefined) {
          formatedStamp = `+${numeral(stamp - lastStamp).format("00000,0.000").replace(/^[0,]*/, toSpaces)}`;
        } else {
          formatedStamp = numeral(stamp).format("000000,0.000").replace(/^[0,]*/, toSpaces);
        }
        console.log(chalk `{reset.black.bgWhite ${formatedStamp}}{reset ${param.prompt} }{reset.${param.color}.${param.bgColor} ${dataToDisplay}}`);
        addToTextFile(`${formatedStamp} ${param.prompt} ${dataToDisplay}`);
        addToHtmlFile(`<span class="stamp">${formatedStamp}</span> ${param.prompt} <span class="color${param.number}">${dataToDisplay}</span>`);
      } else {
        console.log(chalk `{reset.black.bgWhite}{reset ${param.prompt} }{reset.${param.color}.${param.bgColor} ${dataToDisplay}}`);
        addToTextFile(`${param.prompt} ${dataToDisplay}`);
        addToHtmlFile(`${param.prompt} <span class="color${param.number}">${dataToDisplay}</span>`);
      }
      lastStamp = stamp;
    });

    port.on("open", () => {
      const msg = `[port ${param.comPort} open]`;
      console.log(chalk `{cyan.bold ${msg}}`);
      addToTextFile(msg);
      addToHtmlFile(`<span class="open">${msg}</span>`);
    });

    port.on("close", () => {
      const msg = `[port ${param.comPort} closed]`;
      console.log(chalk `{magenta.bold ${msg}}`);
      addToTextFile(msg);
      addToHtmlFile(`<span class="closed">${msg}</span>`);
    });

    port.on("error", () => {
      const msg = `[port ${param.comPort} in error]`;
      console.log(chalk `{red.bold ${msg}}`);
      addToTextFile(msg);
      addToHtmlFile(`<span class="error">${msg}</span>`);
    });

    param.port = port;
  });
}

process.on("SIGINT", function () {
  configuration.forEach(param => {
    param.port.close();
    const msg = `[port ${param.comPort} closed]`;
    console.log(chalk `{magenta.bold ${msg}}`);
    addToTextFile(msg);
    addToHtmlFile(`<span class="closed">${msg}</span>`);
  });
  const theEnd = "===End-of-Recording===";
  closeTextFile(theEnd);
  closeHtmlFile(theEnd);
});
