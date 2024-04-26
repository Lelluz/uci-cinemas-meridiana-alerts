import { flatMap, pick } from 'lodash-es'
import axios from 'axios'
import { S3 } from '@aws-sdk/client-s3'
import moment from 'moment'

const S3_CLIENT = new S3({ region: 'eu-south-1' })
const BUCKET_NAME = process.env.BUCKET_NAME
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHANNEL_CHAT_ID
const CINEMA_ID = process.env.CINEMA_ID
const BEARER_TOKEN = process.env.UCI_BEARER_TOKEN
const UCI_PROGRAMMING_API_URL = `https://www.ucicinemas.it/rest/v3/cinemas/${CINEMA_ID}/programming`
const PROGRAMMING_DATA_FOLDER_PATH = 'programming-data'
const DIFFERENCES_DATA_FOLDER_PATH = 'differences-data'

function compareArray(array1, array2) {
  return array2.filter((valore) => !array1.includes(valore))
}

async function getJSON() {
  const { data: jsonData } = await axios.get(UCI_PROGRAMMING_API_URL, {
    headers: {
      Authorization: `Bearer ${BEARER_TOKEN}`,
    },
  })
  return jsonData
}

async function saveToFile(data, filePath) {
  const params = {
    Bucket: BUCKET_NAME,
    Key: filePath,
    Body: JSON.stringify(data, null, 2),
  }

  try {
    const response = await S3_CLIENT.putObject(params)
    console.log('File saved successfully.', response)
  } catch (error) {
    console.error('Error uploading file to S3:', error)
    throw error
  }
}

function createLightProgrammingStructure(apiResponse) {
  return flatMap(apiResponse, (movie) => {
    return flatMap(movie.events, (event) => {
      return event.performances.map((performance) => {
        return {
          movieId: movie.movieId,
          eventId: event.eventId,
          name: movie.name,
          date: event.date,
          time: performance.time,
          moviePath: event.moviePath,
          screen: performance.screen,
          webUrl: event.webUrl,
          buyUrl: performance.buyUrl,
          moviePosterOriginal: movie.moviePosterOriginal,
          performanceData: `${movie.movieId}~${event.eventId}~${event.date}~${performance.time}`,
        }
      })
    })
  })
}

async function getObjectFromS3(filePath) {
  try {
    const response = await S3_CLIENT.getObject({
      Bucket: BUCKET_NAME,
      Key: filePath,
    })
    return await response.Body?.transformToString()
  } catch (error) {
    console.error('Error retrieving object from S3:', error)
    throw error
  }
}

async function compareAndSaveDifferences(newStructure, penultimateFilePath) {
  const penultimateS3FileObj = await getObjectFromS3(penultimateFilePath)
  const penultimateDataPerformances = JSON.parse(penultimateS3FileObj).map(
    (film) => film.performanceData
  )
  const newStructureDataPerformances = newStructure.map(
    (film) => film.performanceData
  )
  const differences = compareArray(
    penultimateDataPerformances,
    newStructureDataPerformances
  )

  if (differences.length > 0) {
    console.log('Differences detected.')

    const differencesFullData = differences.map((difference) => {
      const differenceFileds = difference.split('~')
      const movieId = parseInt(differenceFileds[0])
      const eventId = parseInt(differenceFileds[1])
      const date = differenceFileds[2]
      const time = differenceFileds[3]
      const movieInfoRaw = newStructure.find(
        (film) => film.performanceData === difference
      )
      const movieInfo = pick(movieInfoRaw, [
        'name',
        'webUrl',
        'buyUrl',
        'screen',
        'moviePosterOriginal',
      ])
      return { movieId, eventId, movieInfo, date, time }
    })

    const timestamp = new Date()
      .toISOString()
      .replace(/:/g, '-')
      .replace(/\./g, '-')

    await saveToFile(
      newStructure,
      `${PROGRAMMING_DATA_FOLDER_PATH}/programming-data_${timestamp}.json`
    )
    await saveToFile(
      differencesFullData,
      `${DIFFERENCES_DATA_FOLDER_PATH}/differences_${timestamp}.json`
    )
    await processFilms(differencesFullData)
  } else {
    console.log('No differences found.')
  }
}

async function processFilms(differencesFullData) {
  for (const film of differencesFullData) {
    const telegramChannelMessageText = `${film.movieInfo.name}


Data: ${new Date(film.date).toLocaleDateString('it-IT')}
Orario: ${film.time}
Sala: ${film.movieInfo.screen}

${film.movieInfo.webUrl}

Biglietti:
${film.movieInfo.buyUrl}
`
    await sendTelegramAlert(
      telegramChannelMessageText,
      film.movieInfo.moviePosterOriginal
    )
  }
}

async function sendTelegramAlert(message, photoUrl) {
  const apiUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`
  const params = {
    chat_id: TELEGRAM_CHAT_ID,
    photo: photoUrl,
    caption: message,
  }

  try {
    const response = await axios.post(apiUrl, params)
    return {
      statusCode: response.status,
      body: JSON.stringify(response.data),
    }
  } catch (error) {
    console.error('Error:', error)

    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal Server Error' }),
    }
  }
}

async function compareLatestTwoFiles(newStructure) {
  const params = {
    Bucket: BUCKET_NAME,
    Prefix: PROGRAMMING_DATA_FOLDER_PATH,
  }

  try {
    const data = await S3_CLIENT.listObjectsV2(params)
    const programmingDataFiles = data.Contents.sort(
      (a, b) => b.LastModified - a.LastModified
    )
    const [latestFile, penultimateFile] = programmingDataFiles.slice(0, 2)

    if (latestFile && penultimateFile) {
      const latestFilePath = latestFile.Key
      const penultimateFilePath = penultimateFile.Key

      await compareAndSaveDifferences(newStructure, latestFilePath)
    }
  } catch (error) {
    console.error('Error in file comparison:', error)
  }
}

async function deleteAllOldFilesInFolder(folderPath) {
  try {
    const objects = await S3_CLIENT.listObjectsV2({
      Bucket: BUCKET_NAME,
      Prefix: folderPath,
    })
    const purgatoryTime = moment().subtract(144, 'hours')

    for (const obj of objects.Contents || []) {
      const lastModified = moment(obj.LastModified)

      if (lastModified.isBefore(purgatoryTime)) {
        await S3_CLIENT.deleteObject({
          Bucket: BUCKET_NAME,
          Key: obj.Key,
        })
      }
    }

    console.log('File eliminati con successo.')
    return {
      statusCode: 200,
      body: JSON.stringify('Operazione completata con successo.'),
    }
  } catch (error) {
    console.error("Errore durante l'eliminazione dei file:", error)
    return {
      statusCode: 500,
      body: JSON.stringify("Errore durante l'eliminazione dei file."),
    }
  }
}

export const handler = async (event) => {
  try {
    const allData = await getJSON()
    const lightProgrammingStructure = createLightProgrammingStructure(allData)

    await compareLatestTwoFiles(lightProgrammingStructure)
    await deleteAllOldFilesInFolder(PROGRAMMING_DATA_FOLDER_PATH)
    await deleteAllOldFilesInFolder(DIFFERENCES_DATA_FOLDER_PATH)
  } catch (error) {
    console.error('Error in Lambda function:', error)
  }
}
