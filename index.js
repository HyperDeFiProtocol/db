const fs = require('fs')
const dotenv = require('dotenv')
const JSBI = require('jsbi')
const BN = JSBI.BigInt
const Web3 = require('web3')
const TOKEN_ABI = require('./contract/token.json')
const IDO_ABI = require('./contract/ido.json')
dotenv.config()

const PROVIDER = new Web3(process.env.web3RpcUrl)
const TOKEN = new PROVIDER.eth.Contract(TOKEN_ABI, process.env.tokenAddress)
const IDO = new PROVIDER.eth.Contract(IDO_ABI, process.env.idoAddress)

const STEP = 5000
const INTERVAL = 200
let BUFFER
let HOLDERS
let BLOCK_NUMBER
let interval = 0
let range = {
  from: process.env.fromBlock,
  to: process.env.fromBlock
}
let step = STEP

let txs = []
let transfers = []
let buffers = []
let airdrops = []
let bonus = []
let funds = []
let genesisDeposits = []
let holders = []
let blocks = []
let blockTimestamps = []

const readFromJson = async function (path) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf-8'))
  } catch (err) {
    console.error(err)
    return []
  }
}

const syncRange = async function (rows) {
  try {
    if (rows.length) {
      const row = rows.slice(-1)[0]

      if (JSBI.GT(BN(row['blockNumber']), BN(range.from))) {
        range.from = BN(row['blockNumber']).toString()
        range.to = range.from
      }
    }
  } catch (e) {
    console.error(e)
  }
}

const writeToJson = async function (path, data) {
  try {
    fs.writeFileSync(path, JSON.stringify(data))
  } catch (err) {
    console.error(err)
    await writeToJson(path, data)
  }
}

// wait...
const wait = function(timeout = 1000) {
  return new Promise((resolve, reject) => {
    if (timeout > 0) {
      setTimeout(() => {
        resolve(timeout)
      }, timeout)
    } else {
      reject('Invalid `timeout`')
    }
  })
}

// cut step
const cut = function(n) {
  const a = 8
  const b = 10

  return JSBI.divide(JSBI.multiply(BN(n), BN(a)), BN(b)).toString()
}

// event 2 tx
const ev2Tx = function (event) {
  return {
    blockNumber: event.blockNumber,
    txHash: event.transactionHash,

    account: event.returnValues.account,
    amount: event.returnValues.amount
  }
}

// interval +
const increaseInterval = async function() {
  interval += INTERVAL
}

// get metadata
const getMetadata = async function() {
  let exception = false
  const metadata = await TOKEN.methods.getMetadata().call().catch(e => {
    exception = true
    console.error('[getMetadata]', e)
  })

  if (exception) {
    await increaseInterval()
    console.log(`wait: getMetadata after ${interval}ms`)
    await wait(interval)
    return await getMetadata()
  }

  interval = 0
  return metadata
}


// get block timestamp
const getBlockTimestamp = async function(s) {
  let exception = false
  const block = await PROVIDER.eth.getBlock(s).catch(e => {
    exception = true
    console.error('[getBlockTimestamp]', e)
  })

  if (exception) {
    await increaseInterval()
    console.log(`wait: getBlockTimestamp after ${interval}ms`)
    await wait(interval)
    return await getBlockTimestamp(s)
  }

  interval = 0
  return block['timestamp']
}


// get block number
const getBlockNumber = async function() {
  let exception = false
  const blockNumber = await PROVIDER.eth.getBlockNumber().catch(e => {
    exception = true
    console.error('[getBlockNumber]', e)
  })

  if (exception) {
    await increaseInterval()
    console.log(`wait: getBlockNumber after ${interval}ms`)
    await wait(interval)
    return await getBlockNumber()
  }

  interval = 0
  return blockNumber
}

//
const stepUp = async function() {
  range.to = JSBI.add(BN(range.from), BN(step)).toString()
  if (JSBI.GT(BN(range.to), BN(BLOCK_NUMBER))) {
    range.to = BN(BLOCK_NUMBER).toString()
  }
}

const fetchAllEvents = async function() {
  console.log(`fetchAllEvents: #${range.from} - #${range.to}/#${BLOCK_NUMBER}`)

  let exception = false
  const events = await TOKEN
    .getPastEvents('allEvents', {
      fromBlock: range.from,
      toBlock: range.to
    }).catch(e => {
      exception = true
      console.error('[fetchAllEvents]', e)
    })

  if (exception) {
    step = cut(step)
    await stepUp()

    await increaseInterval()
    console.log(`wait: fetchAllEvents after ${interval}ms`)
    await wait(interval)
    return await fetchAllEvents()
  }

  step = STEP
  interval = 0
  return events
}


const fetchIDOEvents = async function() {
  console.log(`fetchIDOEvents: #${range.from} - #${range.to}/#${BLOCK_NUMBER}`)

  let exception = false
  const events = await IDO
    .getPastEvents('Deposit', {
      fromBlock: range.from,
      toBlock: range.to
    })
    .catch(e => {
      exception = true
      console.error('[fetchIDOEvents]', e)
    })

  if (exception) {
    await increaseInterval()
    console.log(`wait: fetchIDOEvents after ${interval}ms`)
    await wait(interval)
    return await fetchIDOEvents()
  }

  interval = 0
  return events
}


const syncEvents = async function() {
  BLOCK_NUMBER = await getBlockNumber()

  const metadata = await getMetadata()
  BUFFER = metadata.accounts[4]
  HOLDERS = metadata.holders

  txs = await readFromJson('./mainnet/txs.json')
  transfers = await readFromJson('./mainnet/transfers.json')
  buffers = await readFromJson('./mainnet/buffers.json')
  airdrops = await readFromJson('./mainnet/airdrops.json')
  bonus = await readFromJson('./mainnet/bonus.json')
  funds = await readFromJson('./mainnet/funds.json')
  genesisDeposits = await readFromJson('./mainnet/genesisDeposits.json')

  await syncRange(txs)
  await syncRange(transfers)
  await syncRange(buffers)
  await syncRange(airdrops)
  await syncRange(bonus)
  await syncRange(funds)
  await syncRange(genesisDeposits)

  console.log('blockNumber:', BLOCK_NUMBER)
  console.log('BUFFER:', BUFFER)
  console.log('HOLDERS:', HOLDERS)

  while (JSBI.LT(BN(range.from), BN(BLOCK_NUMBER))) {
    range.from = JSBI.add(BN(range.from), BN(1)).toString()
    await stepUp(step)

    const events = await fetchAllEvents(step)

    for (const event of events) {
      console.log(event.blockNumber, event.event)

      switch (event.event) {
        case 'Transfer':
          transfers.push({
            blockNumber: event.blockNumber,
            txHash: event.transactionHash,
            sender: event.returnValues.from,
            recipient: event.returnValues.to,
            amount: event.returnValues.value,
          })

          if (event.returnValues.from === BUFFER || event.returnValues.to === BUFFER) {
            if (buffers.length) {
              const key = buffers.length - 1
              if (
                buffers[key].txHash === event.transactionHash
                &&
                buffers[key].sender === event.returnValues.from
                &&
                buffers[key].recipient === event.returnValues.to
              ) {
                buffers[key].amount = JSBI.add(BN(buffers[key].amount), BN(event.returnValues.value)).toString()
                break
              }
            }

            buffers.push({
              blockNumber: event.blockNumber,
              txHash: event.transactionHash,
              sender: event.returnValues.from,
              recipient: event.returnValues.to,
              amount: event.returnValues.value,
            })
          }
          break
        case 'TX':
          if (txs.length) {
            const key = txs.length - 1
            if (
              txs[key].txHash === event.transactionHash &&
              txs[key].txType === event.returnValues.txType &&
              txs[key].sender === event.returnValues.sender &&
              txs[key].recipient === event.returnValues.recipient
            ) {
              txs[key].amount = JSBI.add(BN(txs[key].amount), BN(event.returnValues.amount)).toString()
              txs[key].txAmount = JSBI.add(BN(txs[key].txAmount), BN(event.returnValues.txAmount)).toString()
              break
            }
          }

          txs.push({
            blockNumber: event.blockNumber,

            txHash: event.transactionHash,
            txType: event.returnValues.txType,
            sender: event.returnValues.sender,
            recipient: event.returnValues.recipient,

            amount: event.returnValues.amount,
            txAmount: event.returnValues.txAmount
          })
          break
        case 'Airdrop':
          airdrops.push(ev2Tx(event))
          break
        case 'Bonus':
          bonus.push(ev2Tx(event))
          break
        case 'Fund':
          funds.push(ev2Tx(event))
          break
        // case 'SlotRegistered':
        //   break
        // case 'UsernameSet':
        //   break
        // case 'CouponVisitor':
        //   break
      }


    }

    if (JSBI.LT(BN(range.from), BN(process.env.idoToBlock))) {
      const idoEvents = await fetchIDOEvents()
      for (const event of idoEvents) {
        genesisDeposits.push(ev2Tx(event))
      }
    }

    range.from = range.to
    await wait(INTERVAL)
  }


  console.log(`           txs: ${txs.length}`)
  console.log(`     transfers: ${transfers.length}`)
  console.log(`       buffers: ${buffers.length}`)
  console.log(`      airdrops: ${airdrops.length}`)
  console.log(`         bonus: ${bonus.length}`)
  console.log(`         funds: ${funds.length}`)
  console.log(`genesisDeposit: ${genesisDeposits.length}`)

  await writeToJson('./mainnet/txs.json', txs)
  await writeToJson('./mainnet/transfers.json', transfers)
  await writeToJson('./mainnet/buffers.json', buffers)
  await writeToJson('./mainnet/airdrops.json', airdrops)
  await writeToJson('./mainnet/bonus.json', bonus)
  await writeToJson('./mainnet/funds.json', funds)
  await writeToJson('./mainnet/genesisDeposits.json', genesisDeposits)
}

const pushBlocksFromJson = async function (path) {
  const txs = await readFromJson(path)

  for (const tx of txs) {
    if (blocks.length === 0 || blocks.indexOf(tx['blockNumber']) === -1) {
      blocks.push(tx['blockNumber'])
    }
  }
}

const isInBlockTimestamps = async function (blockNumber) {
  for (const row of blockTimestamps) {
    if (row.blockNumber === blockNumber) return true
  }

  return false
}

const syncBlockTimestamps = async function () {
  blocks = []
  BLOCK_NUMBER = await getBlockNumber()

  blockTimestamps = await readFromJson('./mainnet/blockTimestamps.json')
  await pushBlocksFromJson('./mainnet/txs.json')
  await pushBlocksFromJson('./mainnet/transfers.json')
  await pushBlocksFromJson('./mainnet/buffers.json')
  await pushBlocksFromJson('./mainnet/airdrops.json')
  await pushBlocksFromJson('./mainnet/bonus.json')
  await pushBlocksFromJson('./mainnet/funds.json')
  await pushBlocksFromJson('./mainnet/genesisDeposits.json')

  blocks.sort()

  for (const blockNumber of blocks) {
    if (!await isInBlockTimestamps(blockNumber)) {
      const row = {
        blockNumber: blockNumber,
        timestamp: await getBlockTimestamp(blockNumber)
      }
      console.log(`#${row.blockNumber} => ${row.timestamp} / #${BLOCK_NUMBER}`)
      blockTimestamps.push(row)
    }
  }

  await writeToJson('./mainnet/blockTimestamps.json', blockTimestamps)
}


// const syncHolders = async function () {
//   holders = []
//   BLOCK_NUMBER = await getBlockNumber()
//
//   const metadata = await getMetadata()
//   BUFFER = metadata.accounts[4]
//   HOLDERS = metadata.holders
//
//   console.log(HOLDERS)
//
//   while (JSBI.LT(BN(holders.length), JSBI.subtract(BN(HOLDERS), BN(1)))) {
//     console.log(`Holders: #${holders.length}`)
//     const holdersResp = await TOKEN.methods.getHolders(holders.length).call()
//       .catch(e => {
//         console.error('>>> sync, syncHolders:', e)
//       })
//
//     for (let i = 0; i < holdersResp.ids.length; i++) {
//       if (holdersResp.holders[i] !== '0x0000000000000000000000000000000000000000') {
//         holders.push({
//           id: holdersResp.ids[i],
//           address: holdersResp.holders[i],
//           username: holdersResp.usernames[i],
//           balance: holdersResp.balances[i],
//           isWhale: holdersResp.isWhales[i],
//         })
//       }
//     }
//   }
//
//   console.log(holders.length)
// }

syncEvents().then()
syncBlockTimestamps().then()
// syncHolders().then()
