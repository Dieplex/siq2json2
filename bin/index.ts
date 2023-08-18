#!/usr/bin/env node

import {Entry, Package, Round, SIGame} from './types';
import * as chalk from 'chalk';
import * as yargs from 'yargs';
import * as fs from 'fs';
import {promisify} from 'util';
import * as path from 'path';
import * as unzipper from 'unzipper';
import * as xml2js from 'xml2js';
import * as il from 'iconv-lite';
import * as rimraf from 'rimraf';

const readFilePromise = promisify(fs.readFile);
const unlinkPromise = promisify(fs.unlink);
const removeDirPromise = promisify(fs.rmdir);
const renamePromise = promisify(fs.rename)

const options = yargs.argv;

let relativePath = options._[0];
let extension = path.extname(relativePath);

if (!extension) {
  extension = '.siq';
  relativePath += extension;
}

if (extension !== '.siq') {
  console.error(chalk.yellow('Unsupported file extension'));
  process.exit(1);
}

const zipFilePath = path.resolve(process.cwd(), relativePath) as string;

if (!fs.existsSync(zipFilePath)) {
  console.error(chalk.yellow('Unable to locate file at', zipFilePath));
  process.exit(1);
}

const filename = path.basename(relativePath).replace(extension, '');
const unzippedFolder = path.resolve(path.dirname(zipFilePath), filename);
const rootXml = path.normalize(`${unzippedFolder}/content.xml`);

const unzip = (zipFilePath: string): Promise<void> => {
  return new Promise((resolve, reject) => {
    const assertedPaths = [] as string[];
    fs.createReadStream(zipFilePath)
      .pipe(unzipper.Parse())
      .on('entry', (entry: Entry) => {
        const decodedFileName = decodeURIComponent(
          entry.isUnicode
            ? entry.path
            : il.decode(entry.props.pathBuffer, 'cp866')
        );
        const fileDestination = path.join(unzippedFolder, decodedFileName);
        const directory = path.dirname(fileDestination);
        if (!assertedPaths.includes(directory) && !fs.existsSync(directory)) {
          fs.mkdirSync(directory, { recursive: true });
          assertedPaths.push(directory);
        }

        entry.pipe(fs.createWriteStream(fileDestination));
      })
      .once('close', resolve)
      .once('error', reject);
  });
};

const unWrap = (array: any[], onEntry: Function) => {
  return array.reduce((acc, entry) => {
    const retrievedEntry = onEntry(entry);
    return Array.isArray(retrievedEntry) ? acc.concat(retrievedEntry) : [...acc, retrievedEntry];
  }, []);
}

const convertToJSON = (gamePackage: SIGame.Package): Package => {
  const { $, info, rounds } = gamePackage;
  const authorsInfo = info.find(entry => !!entry.authors);
  const authors = authorsInfo
    ? unWrap(authorsInfo.authors, (obj: SIGame.Author) => obj.author)
    : [];
  const gameRounds = unWrap(rounds[0].round, (round: SIGame.RoundData) => {
    return {
      name: round.$.name,
      themes: unWrap(round.themes[0].theme, (theme: SIGame.ThemeData) => {
        return {
          name: theme.$.name,
          questions: unWrap(theme.questions[0].question, (question: SIGame.QuestionData) => {
            const q = {
              points: parseInt(question.$.price, 10),
              mode: 'default',
              type: 'plain',
              answers: question.right[0].answer,
              task: {
                text: '',
                images: [] as string[],
                sounds: [] as string[],
                video:  [] as string[],
              },
              explanation: ''
            };

            if (question.info) {
              q.explanation = question.info[0].comments[0];
            }

            if (question.type) {
              const typeName = question.type[0].$.name;
              switch (typeName) {
                case 'cat':
                case 'bagcat':
                  q.mode = 'delegate'
                  if (Array.isArray(question.type[0].param)) {
                    for (const param of question.type[0].param) {
                      switch (param.$.name) {
                        case 'cost':
                          q.points = parseInt(param._, 10);
                          break;
                        case 'theme':
                          q.explanation = param._;
                          break;
                        default:
                          break;
                      }
                    }
                  }
                  break;
                default:
                  q.mode = typeName;
              }
            }

            const setQuestionMediaTask = (mediaScenario: SIGame.MediaScenario) => {
              switch (mediaScenario.$.type) {
                case 'image':
                  q.task.images.push(path.normalize(mediaScenario._.replace('@', ``)));
                  break;
                case 'voice':
                  q.task.sounds.push(path.normalize(mediaScenario._.replace('@', ``)));
                  break;
                case 'video':
                  q.task.video.push(path.normalize(mediaScenario._.replace('@', ``)));
                  break;
                case 'say':
                  q.explanation = mediaScenario._;
                  break;
                case 'marker':
                  break;
                default:
                  console.warn(`Detected unhandled scenario type "${mediaScenario.$.type}. Please open a ticket to support it`);
              }
            }

            const scenarioDetails = question.scenario[0].atom;
            if (scenarioDetails.length === 1 && typeof scenarioDetails[0] === 'string') {
              q.task.text = scenarioDetails[0];
            } else {
              q.type = 'media';
              if (scenarioDetails.length > 1) {
                for (const scenario of scenarioDetails) {
                  if (typeof scenario === 'string') {
                    q.task.text = scenario;
                  } else {
                    setQuestionMediaTask(scenario as SIGame.MediaScenario);
                  }
                }
              } else {
                setQuestionMediaTask(scenarioDetails[0] as SIGame.MediaScenario)
              }
            }

            return q;
          })
        };
      })
    };
  }) as Round[];

  return {
    id: $.id,
    name: $.name,
    rounds: gameRounds,
    metadata: {
      version: $.version,
      createdBy: authors,
      difficulty: $.difficulty,
      restriction: $.restriction,
      createdAt: $.date
    }
  };
}

const removeDir = (dirPath: string) => new Promise((resolve, reject) => {
  rimraf(dirPath, (err) => {
    if (err) return reject(err);
    return resolve();
  })
})

unzip(zipFilePath)
  .then(() => {
    return readFilePromise(rootXml);
  })
  .then((xml) => {
    return xml2js.parseStringPromise(xml);
  })
  .then((parcedPackage) => {
    console.log(chalk.yellow(parcedPackage.package.$.id));
    const convertedJSON = convertToJSON(parcedPackage.package);
    fs.writeFileSync(path.join(unzippedFolder, 'scenario.json'), JSON.stringify(convertedJSON, null, 2));
    return path.resolve(path.dirname(zipFilePath), parcedPackage.package.$.id)
  })
  .then((renamedFolder) => {
    if (fs.existsSync(renamedFolder)) {
      return removeDirPromise(renamedFolder, {recursive: true}).then(() => renamedFolder)
    }
    return renamedFolder
  })
  .then((folderPath) => {
    return renamePromise(unzippedFolder, folderPath).then(() => folderPath)
  })
  .then((folderPath) => {
    return Promise.allSettled([
      unlinkPromise(path.resolve(folderPath, 'content.xml')),
      unlinkPromise(path.resolve(folderPath, '[Content_Types].xml')),
      removeDir(path.resolve(folderPath, './Texts')),
    ])
  })
  .catch((error) => {
    if (error.code !== 'ENOENT') {
      console.error(chalk.red('Failed to parse the file: ', error.message));
    }
  });
