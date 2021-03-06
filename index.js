// Copyright (c) 2018, TurtleCoin Developers
//
// Please see the included LICENSE file for more information.

'use strict'

require('dotenv').config()
const Config = require('./config.json')
const Discord = require('discord.js')
const Franc = require('franc')
const ISO6391 = require('iso-639-1')
const Sqlite3 = require('sqlite3')
const Translator = require('google-translate')(process.env.GOOGLE_API_KEY || Config.translation.apiKey)
const util = require('util')

const Client = new Discord.Client()

const db = new Sqlite3.Database(Config.database, (err) => {
  if (err) {
    log('Could not connect to backend database')
    process.exit(1)
  }
  run([
    'CREATE TABLE IF NOT EXISTS ',
    'exiled_users ',
    '(id TEXT PRIMARY KEY, oldNickname TEXT, reason TEXT)'
  ].join('')).then(() => {
    log('Connected to backend database')
  }).catch(() => {
    log('Could not create "exiled_users" table')
    process.exit(1)
  })
})

function BreakSignal () {}

function run (query, args) {
  return new Promise((resolve, reject) => {
    db.run(query, args, (err) => {
      if (err) return reject(err)
      return resolve()
    })
  })
}

function get (query, args) {
  args = args || []
  return new Promise((resolve, reject) => {
    db.get(query, args, (err, row) => {
      if (err || !row) return reject(err)
      return resolve(row)
    })
  })
}

function getAll (query, args) {
  args = args || []
  return new Promise((resolve, reject) => {
    db.all(query, args, (err, rows) => {
      if (err || !rows) return reject(err)

      return resolve(rows)
    })
  })
}

function isExiled (id) {
  return new Promise((resolve, reject) => {
    get('SELECT * FROM exiled_users WHERE id = ?', [id]).then((row) => {
      if (row.id === id) return resolve({ status: true, oldNickname: row.oldNickname })
      return resolve({ status: false })
    }).catch(() => {
      return resolve({ status: false })
    })
  })
}

function getAllExiled () {
  return getAll('SELECT * FROM exiled_users')
    .catch(() => { return [] })
}

function getExileReason (id) {
  return new Promise((resolve, reject) => {
    get('SELECT reason FROM exiled_users WHERE id = ?', [id]).then((row) => {
      return resolve(row.reason)
    }).catch(() => {
      return resolve('')
    })
  })
}

function exile (id, oldNickname, reason) {
  reason = cleanMessage(reason)
  return new Promise((resolve, reject) => {
    run('REPLACE INTO exiled_users (id, oldNickname, reason) VALUES (?,?,?)', [id, oldNickname, reason]).then(() => {
      return resolve(true)
    }).catch(() => {
      return reject(new Error('Could not save exile to database'))
    })
  })
}

function release (id) {
  return new Promise((resolve, reject) => {
    run('DELETE FROM exiled_users WHERE id = ?', [id]).then(() => {
      return resolve()
    }).catch(() => {
      return reject(new Error('Could not release user from database'))
    })
  })
}

function tryChangeNickname (member, newNickname) {
  return new Promise((resolve, reject) => {
    member.setNickname(newNickname).then(() => {
      return resolve(true)
    }).catch(() => {
      return resolve(false)
    })
  })
}

function tryChannelSendMessage (channel, message) {
  return new Promise((resolve, reject) => {
    channel.send(message).then(() => {
      return resolve(true)
    }).catch(() => {
      return resolve(false)
    })
  })
}

function tryRemoveRole (member, role) {
  return new Promise((resolve, reject) => {
    member.removeRole(role).then(() => {
      return resolve(true)
    }).catch(() => {
      return resolve(false)
    })
  })
}

function tryAddRole (member, role) {
  return new Promise((resolve, reject) => {
    member.addRole(role).then(() => {
      return resolve(true)
    }).catch(() => {
      return resolve(false)
    })
  })
}

function tryMessageReact (message, reaction) {
  return new Promise((resolve, reject) => {
    message.react(reaction).then(() => {
      return resolve(true)
    }).catch(() => {
      return resolve(false)
    })
  })
}

function tryTranslation (message) {
  return new Promise((resolve, reject) => {
    const lang = Franc(message)
    const langName = ISO6391.getName(lang) || lang

    if (lang === 'eng') {
      return resolve({ message: message, original: message, lang: 'English' })
    }

    if (!Config.translation.apiKey) {
      return resolve({ message: message, original: message, lang: 'disabled' })
    }

    Translator.translate(message, 'en', (error, translation) => {
      if (error) return resolve({ message: message, original: message, lang: langName })
      translation.detectedSourceLanguage = translation.detectedSourceLanguage.split('-', 1).join('')
      return resolve({ message: translation.translatedText, original: message, lang: ISO6391.getName(translation.detectedSourceLanguage) })
    })
  })
}

function execExile (message, member, channel, role, removeRole) {
  const oldNickname = member.displayName
  const id = RandomNumber()
  const newNickname = `${Config.inmateNamePrefix} ${id}`

  /* Try to change their nickname */
  tryChangeNickname(member, newNickname).then((success) => {
    if (success) {
      log(`${message.author.username} changed nickname of "${oldNickname}" to "${newNickname}"`)
    }
    /* Add the role to their account */
    return tryAddRole(member, role)
  }).then(() => {
    /* Remove the role if necesseary */
    if (removeRole) {
      return tryRemoveRole(member, removeRole)
    }
  }).then(() => {
    /* Store the exile in the database */
    return exile(member.id, oldNickname, message.content.toString())
  }).then(() => {
    log(`${message.author.username} assigned role "${role.name}" to "${newNickname}"`)
    const mention = member.toString()

    /* Try to send a message to the channel letting them know they are exiled */
    return tryChannelSendMessage(channel, `${mention} ${Config.exileMessage}`)
  }).then(() => {
    /* React to the initial message */
    return tryMessageReact(message, Config.reaction)
  }).catch((error) => {
    if (!(error instanceof BreakSignal)) {
      log(`Error assigning "${role.name}" to "${member.displayName}": ${error}`)
    }
  })
}

function execRename (message, member) {
  const oldNickname = member.displayName
  const newNickname = cleanMessage(message.content.toString())

  tryChangeNickname(member, newNickname).then((success) => {
    if (success) {
      log(`${message.author.username} changed nickname of "${oldNickname}" to "${newNickname}"`)

      /* React to the initial message, but only if it works */
      return tryMessageReact(message, Config.reaction)
    } else {
      throw new Error('I sorry, I cannot do that Dave')
    }
  }).catch((error) => {
    if (!(error instanceof BreakSignal)) {
      log(`Error changing nickname of "${oldNickname}" to "${newNickname}": ${error}`)
    }
  })
}

function execRelease (message, member, channel, role) {
  /* Check to see if they are already exiled */
  isExiled(member.id).then((result) => {
    /* Try to change their nickname back */
    if (result.status) {
      return tryChangeNickname(member, result.oldNickname)
    }
  }).then(() => {
    /* Remove the role from their account */
    return tryRemoveRole(member, role)
  }).then(() => {
    /* remove the exile from the database */
    return release(member.id)
  }).then(() => {
    /* React to the initial message */
    return tryMessageReact(message, Config.reaction)
  }).then(() => {
    log(`${message.author.username} removed role "${role.name}" from "${member.displayName}"`)
  }).catch((error) => {
    if (!(error instanceof BreakSignal)) {
      log(`Error removing "${role.name}" from "${member.displayName}"`)
    }
  })
}

function execReleaseAll (message, role) {
  const members = []
  const nicknames = {}
  getAllExiled()
    .then(rows => {
      rows.forEach(row => {
        const member = message.guild.members.find(r => r.id === row.id)

        if (member) {
          nicknames[member.id] = row.oldNickname
          members.push(member)
        }
      })
    })
    .then(() => {
      /* Try to change all the nicknames back */
      const promises = []

      members.forEach(member => promises.push(tryChangeNickname(member, nicknames[member.id])))

      return Promise.all(promises)
    })
    .then(() => {
      /* Remove the role from their accounts */
      const promises = []

      members.forEach(member => promises.push(tryRemoveRole(member, role)))

      return Promise.all(promises)
    })
    .then(() => {
      /* remove the exiles from the database */
      const promises = []

      members.forEach(member => promises.push(release(member.id)))

      return Promise.all(promises)
    })
    .then(() => {
      /* React to the initial message */
      return tryMessageReact(message, Config.reaction)
    })
    .then(() => {
      log(`${message.author.username} removed role "${role.name}" from all currently connected inmates [${members.length}]`)
    })
    .catch(error => {
      if (!(error instanceof BreakSignal)) {
        log(`Error removing "${role.name}" from all exiled users`)
      }
    })
}

function RandomNumber () {
  const rn = require('random-number')
  const gen = rn.generator({
    min: 10000,
    max: 99999,
    integer: true
  })
  return gen()
}

function isEnforcer (id) {
  if (Config.enforcers.indexOf(id) === -1) {
    return false
  }
  return true
}

function cleanMessage (msg) {
  msg = msg || ''
  msg = msg.replace(`${Config.trigger}exile`, '')
  msg = msg.replace(`${Config.trigger}unexile`, '')
  msg = msg.replace(`${Config.trigger}crime`, '')
  msg = msg.replace(`${Config.trigger}release`, '')
  msg = msg.replace(`${Config.trigger}rename`, '')
  msg = msg.replace(/<@!?[0-9]*>/, '')
  return msg.trim()
}

function log (message) {
  console.log(util.format('%s: %s', (new Date()).toUTCString(), message))
}

Client.on('ready', () => {
  log(`Logged in as ${Client.user.tag}!`)
})

/* This handler is designed to check for market related talk in any language */
Client.on('message', (message) => {
  /* Check to make sure that we're in a monitored server */
  if (Config.serverIds.indexOf(message.guild.id) === -1) return

  const channelName = message.channel.name
  const guildName = message.guild.name

  /* Get the user so we can mention them later */
  const mention = message.author.username

  if (mention.toLowerCase() === 'mee6') return

  /* Try to translate the message */
  tryTranslation(message.content).then((messageObj) => {
    const msg = messageObj.message.toLowerCase()

    /* Now loop through our trigger words and see if someone has been naughty */
    var triggered = false
    Config.translation.triggerWords.forEach((triggerWord) => {
      triggerWord = triggerWord.toLowerCase()

      if (msg.indexOf(triggerWord) !== -1) {
        triggered = true
      }
    })

    /* Ut oh, someone has been naughty */
    if (triggered) {
      const msgPayload = {
        embed: {
          title: `Market Talk in ${guildName} #${channelName}?`,
          author: {
            name: mention
          },
          url: `https://discordapp.com/channels/${message.guild.id}/${message.channel.id}/${message.id}`,
          fields: [
            {
              name: 'Original Message',
              value: messageObj.original
            },
            {
              name: 'Translated',
              value: msg
            }
          ],
          footer: {
            text: `Language: ${messageObj.lang}`
          }
        }
      }
      if (messageObj.lang === 'English' || messageObj.lang === 'disabled') msgPayload.embed.fields.splice(-1, 1)
      log(msg)
      Client.guilds.get(Config.translation.notificationGuild).channels.get(Config.translation.notificationChannel)
      Client.guilds.get(Config.translation.notificationGuild).channels.get(Config.translation.notificationChannel).send(msgPayload).catch((err) => { log(err) })
    }
  })
})

Client.on('message', (message) => {
  /* Check to make sure that we should be monitoring the server
     that we are connected to */
  if (Config.serverIds.indexOf(message.guild.id) === -1) return

  /* Go get our role that we want to use for naughty people */
  const role = message.guild.roles.find(r => r.name === Config.exileRoleName)

  /* Go get the role that we need to remove */
  const removeRole = message.guild.roles.find(r => r.name === Config.removeRole)

  /* Go get the channel where we'll be printing our nice messages to the naughty people */
  const channel = message.guild.channels.find(channel => channel.name === Config.exileChannelName)

  /* If we couldn't get the correct role then we need to bail */
  if (!role) return

  /* Did someone call for an exile? */
  if (message.content.startsWith(`${Config.trigger}exile`)) {
    /* Set the message to delete */
    message.delete(Config.deleteAfter).catch((error) => { log(error) })

    /* Loop through the mentioned users */
    message.mentions.members.forEach((member) => {
      /* If we don't have access to run this command... */
      if (!isEnforcer(message.author.id)) {
        /* If we tried to exile an enforcer */
        if (isEnforcer(member.id)) {
          log(`${message.author.username} fought the law and the law won!`)
          execExile(message, message.member, channel, role, removeRole)
          return setTimeout(() => {
            execRelease(message, message.member, channel, role)
            log(`${message.author.username} has been released from the drunk tank`)
          }, Config.drunktankTimer)
        }

        /* We're done here */
        return
      } else if (isEnforcer(member.id)) {
        /* We don't let enforcers exile enforcers */
        return
      }

      execExile(message, member, channel, role, removeRole)
    })
  /* Or are we going to release everyone */
  } else if (message.content.startsWith(`${Config.trigger}releaseall`)) {
    /* Set the message to delete - it deletes slower because it often takes longer */
    message.delete(Config.deleteAfter * 3).catch((error) => { log(error) })

    /* If we don't have permission to perform this command, then we'll pretend like nothing happened */
    if (!isEnforcer(message.author.id)) return

    execReleaseAll(message, role)

  /* Or are we going to release the person */
  } else if (message.content.startsWith(`${Config.trigger}release`) || message.content.startsWith(`${Config.trigger}unexile`)) {
    /* Set the message to delete */
    message.delete(Config.deleteAfter).catch((error) => { log(error) })

    /* If we don't have permission to perform this command, then we'll pretend like nothing happened */
    if (!isEnforcer(message.author.id)) return

    message.mentions.members.forEach((member) => {
      execRelease(message, member, channel, role)
    })
  } else if (message.content.startsWith(`${Config.trigger}crime`)) {
    /* Set the message to delete */
    message.delete(Config.deleteAfter).catch((error) => { log(error) })

    const mention = message.member.toString()

    /* If they aren't an enforcer, look at themselves */
    if (!isEnforcer(message.author.id)) {
      getExileReason(message.author.id).then((reason) => {
        if (reason.length !== 0) {
          reason = '```' + reason + '```'
          return message.channel.send(`${mention} The message scrawled across your warrant states: ${reason}`).catch(() => {})
        } else {
          return message.channel.send(`${mention} There is no warant out for you`).catch(() => {})
        }
      })
    } else {
      const target = message.mentions.members.first()
      if (!target) return

      getExileReason(target.id).then((reason) => {
        if (reason.length !== 0) {
          return message.channel.send(`The warrant for ${target} states: ${reason}`).catch(() => {})
        }
      })
    }
  } else if (message.content.startsWith(`@${Config.exileRoleName}`)) {
    /* Set the message to delete */
    message.delete(Config.deleteAfter).catch((error) => { log(error) })

    /* Did someone call @exiled? */
    return message.channel.send('https://youtu.be/u0I5ZZ6dlto').catch(() => {})
  } else if (message.content.startsWith(`${Config.trigger}rename`)) {
    /* Set the message to delete */
    message.delete(Config.deleteAfter).catch((error) => { log(error) })

    /* If we don't have permission to perform this command, then we'll pretend like nothing happened */
    if (!isEnforcer(message.author.id)) return

    const member = message.mentions.members.first()

    execRename(message, member)
  }
})

function handleProtected (member) {
  if (isEnforcer(member.id)) return
  const role = member.guild.roles.find(r => r.name === Config.exileRoleName)
  const notificationRole = member.guild.roles.find(r => r.name === Config.protectedNotification.role)
  const channel = member.guild.channels.find(channel => channel.name === Config.exileChannelName)
  const notificationChannel = member.guild.channels.find(channel => channel.name === Config.protectedNotification.channel)

  if (!role) return

  const oldNickname = member.displayName
  const id = RandomNumber()
  const newNickname = `${Config.inmateNamePrefix} ${id}`

  Config.protectedUsernames.forEach(nick => {
    if (oldNickname.toLowerCase().indexOf(nick.toLowerCase()) !== -1) {
      log(`${oldNickname} joined with a protected username... sending them to exile`)

      return tryChangeNickname(member, newNickname)
        .then(() => {
          log(`Autojoin changed nickname of "${oldNickname}" to "${newNickname}"`)

          return tryAddRole(member, role)
        })
        .then(() => {
          log(`Autojoin assigned role "${role.name}" to "${newNickname}"`)
          const mention = member.toString()

          /* Try to send a message to the channel letting them know they are exiled */
          return tryChannelSendMessage(channel, `${mention} Excellent. You've joined with a protected nickname. We don't support scamming users here. Sorry.`)
        })
        .then(() => {
          const msgPayload = {
            embed: {
              title: 'Possible Scammer Alert!',
              author: {
                name: oldNickname
              },
              fields: [
                {
                  name: 'Look what I found!',
                  value: 'This user has joined with a protected nickname. Please be vigilant if you have ignored our warnings about turning DMs off.'
                },
                {
                  name: 'Exiled Name',
                  value: newNickname
                }
              ],
              footer: {
                text: 'Seriously, turn off your DMs.'
              }
            }
          }

          return notificationChannel.send(msgPayload).catch((err) => { log(err) })
        })
        .then(() => {
          return tryChannelSendMessage(notificationChannel, `Going to need some help with this one ${notificationRole}... please handle...`)
        })
        .catch((error) => {
          if (!(error instanceof BreakSignal)) {
            log('Error handling user join')
            console.log(error)
          }
        })
    }
  })
}

/* This handler is designed to grab naughty users that try to use protected usernames */
Client.on('guildMemberAdd', member => handleProtected(member))
Client.on('guildMemberUpdate', (oldMember, newMember) => handleProtected(newMember))

Client.on('guildMemberAdd', (member) => {
  const role = member.guild.roles.find(r => r.name === Config.exileRoleName)
  const channel = member.guild.channels.find(channel => channel.name === Config.exileChannelName)

  if (!role) return

  const oldNickname = member.displayName
  const id = RandomNumber()
  const newNickname = `${Config.inmateNamePrefix} ${id}`

  /* check to see if the joiner is in exiled */
  isExiled(member.id).then((result) => {
    if (!result.status) {
      throw new BreakSignal()
    }

    log(`${oldNickname} rejoined the server and they should be in exile`)

    /* Try to change their nickname */
    return tryChangeNickname(member, newNickname)
  }).then(() => {
    log(`Autojoin changed nickname of "${oldNickname}" to "${newNickname}"`)

    /* Add the role to their account */
    return tryAddRole(member, role)
  }).then(() => {
    log(`Autojoin assigned role "${role.name}" to "${newNickname}"`)
    const mention = member.toString()

    /* Try to send a message to the channel letting them know they are exiled */
    return tryChannelSendMessage(channel, `${mention} ${Config.exileEvadeMessage}`)
  }).catch((error) => {
    if (!(error instanceof BreakSignal)) {
      log('Error handling user join')
      console.log(error)
    }
  })
})

Client.login(process.env.DISCORD_TOKEN || Config.token)
  .catch(err => {
    log('There was an error logging into Discord... please check your token and try again')
    log(err.toString())
  })

Client.on('error', error => {
  log('The connection to discord encountered an error: ' + error.toString())
  process.exit(1)
})
