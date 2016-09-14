'use strict'

let logger = require('./modules/errorLogger'),
	emails = require('./modules/emails'),
	generalStore = require('./modules/generalStore'),
	tokenManager = require('./modules/tokenManager'),
	Sequelize = require('sequelize'),
	express = require('express'),
	wrap = require('co-express'),
	expressSession = require('express-session'),
	passport = require('passport'),
	redis = require('redis'),
	RedisStore = require('connect-redis')(expressSession),
	http = require('http'),
	bodyParser = require('body-parser'),
	multipart = require('connect-multiparty'),
	cookieParser = require('cookie-parser'),
	requestLogger = require('morgan'),
	path = require('path'),
	pug = require('pug'),
	fs = require('fs'),
	moment = require('moment'),
	pd = require('pretty-data').pd,
	defaultConfig = require('./defaults/config'),
	defaultClientSettings = require('./defaults/clientSettings'),
	defaultApiSettings = require('./defaults/apiSettings'),
	baseDBClass = require('./base/dbClass'),
	baseClientClass = require('./base/clientClass'),
	baseApiClass = require('./base/apiClass')

class Core {
	constructor(cfg) {
		try {
			this.cfg = cfg || defaultConfig
			this.logger = new logger(this.cfg)
			this.mailClient = new emails(this.cfg)
			this.generalStore = new generalStore(this.cfg)
			this.tokenManager = new tokenManager({generalStore: this.generalStore})
			this.modules = {}

			// ####### ------------ LOAD THE DATABASE MODULE ---------- ####### \\
			let moduleDir = fs.readdirSync(this.cfg.db.modulePath),
				sequelize = new Sequelize(this.cfg.postgres.database, this.cfg.postgres.user, this.cfg.postgres.pass, {
					host: this.cfg.postgres.host,
					port: this.cfg.postgres.port,
					dialect: 'postgres',
					logging: (this.cfg.postgres.logging === true) ?
						(sql) => {
							console.log('================ SQL ==================')
							console.log(pd.sql(sql))
							console.log('================ /SQL ==================')
						} : false
				}),
				CORE = this

			this.modules.db = {
				components: {},
				seedingOrder: this.cfg.db.seedingOrder
			}
			moduleDir.forEach((componentDir, index) => {
				if (componentDir.indexOf('.') === -1) {
					this.modules.db.components[componentDir] = new (require(path.join(__dirname, 'db', componentDir)))(sequelize, Sequelize, {
						mailClient: this.mailClient,
						cfg: this.cfg,
						logger: this.logger
					})
				}
			})

			// ----- create the database associations and update the modules -------- \\
			for (let componentName in this.modules.db.components) {
				let component = this.modules.db.components[componentName],
					relKey = component.associate(this.modules.db.components)
			}
			this.modules.db.sequelize = sequelize
			this.modules.db.Sequelize = Sequelize
			for (let componentName in this.modules.db.components) {
				let component = this.modules.db.components[componentName]
				component.setDb(this.modules.db)
			}

			this.modules.db.sequelize.sync()


			// ####### ------------ LOAD THE CLIENT SERVER MODULES ---------- ####### \\
			this.modules.clients = {}

			let modulesDirPath = this.cfg.clientModulesPath,
				modulesDirData = fs.readdirSync(modulesDirPath),
				settings = {passport}
			modulesDirData.forEach((moduleDir, index) => {
				if (moduleDir.indexOf('.') === -1) {
					let moduleDirPath = path.join(modulesDirPath, moduleDir),
						moduleDirData = fs.readdirSync(moduleDirPath),
						moduleData = {},
						moduleSettings = {}

					try{
						moduleSettings = require(path.join(moduleDirPath, 'settings'))
					} catch (e) {
						console.log(`Could not load the settings for client module ${moduleDir}. Using defaults.`)
						moduleSettings = defaultClientSettings
					}

					moduleDirData.forEach((componentDir, index) => {
						if (componentDir.indexOf('.') === -1) {
							moduleData[componentDir] = new (require(path.join(moduleDirPath, componentDir)))(settings)
						}
					})

					for (let key in moduleSettings){
						settings[key] = moduleSettings[key]
					}

					this.modules.clients[moduleDir] = {moduleData, settings}
				}
			})


			// ####### ------------ LOAD THE API SERVER MODULES ---------- ####### \\
			this.modules.apis = {}

			modulesDirPath = this.cfg.apiModulesPath
			modulesDirData = fs.readdirSync(modulesDirPath)
			settings = {}
			modulesDirData.forEach((moduleDir, index) => {
				if (moduleDir.indexOf('.') === -1) {
					let moduleDirPath = path.join(modulesDirPath, moduleDir),
						moduleDirData = fs.readdirSync(moduleDirPath),
						moduleData = {},
						moduleSettings = {}

					try{
						moduleSettings = require(path.join(moduleDirPath, 'settings'))
					} catch (e) {
						console.log(`Could not load the settings for API module ${moduleDir}. Using defaults.`)
						moduleSettings = defaultApiSettings
					}

					moduleDirData.forEach((componentDir, index) => {
						if (componentDir.indexOf('.') === -1) {
							moduleData[componentDir] = new (require(path.join(moduleDirPath, componentDir)))(settings)
						}
					})

					for (let key in moduleSettings){
						settings[key] = moduleSettings[key]
					}

					this.modules.apis[moduleDir] = {moduleData, settings}
				}
			})
		} catch (e) {
			console.log(e)
		}
	}

	listen() {
		try {
			let CORE = this

			// ------------ LOAD THE CLIENTS' ROUTES ---------- \\
			let redisClient = redis.createClient(this.cfg.redis.port, this.cfg.redis.host, {}),
				sessionStore = new RedisStore({
					host: this.cfg.redis.host,
					port: this.cfg.redis.port,
					client: redisClient
				})

			for (let moduleName in this.modules.clients) {
				// build the layout.html file
				let publicSourcesPath = path.join(this.cfg.clientModulesPublicSourcesPath, moduleName),
					layoutFile = (pug.compileFile(path.join(publicSourcesPath, 'layout_' + this.cfg.name + '.pug'), {}))(),
					layoutFilePath = path.join(this.cfg[moduleName].publicPath, 'layout.html'),
					clientModule = this.modules.clients[moduleName]

				fs.openSync(layoutFilePath, 'w')
				fs.writeFileSync(layoutFilePath, layoutFile)

				clientModule.app = express()
				clientModule.router = express.Router()
				clientModule.paths = []


				//set up request logging and request body parsing
				clientModule.app.use(requestLogger(`[${moduleName} client] :method request to :url; result: :status; completed in: :response-time; :date`))
				clientModule.app.use(bodyParser.json())  // for 'application/json' request bodies
				clientModule.app.use(bodyParser.urlencoded({extended: false})) // 'x-www-form-urlencoded' request bodies
				clientModule.app.use(multipart({uploadDir: this.cfg.globalUploadPath})) // for multipart bodies - file uploads etc.
				clientModule.app.use(cookieParser())

				//set up the passport session
				clientModule.app.use(expressSession({
					secret: this.cfg[moduleName].session.secret,
					key: this.cfg[moduleName].session.key,
					resave: true,
					saveUninitialized: true,
					cookie: {
						httpOnly: true
					},
					store: sessionStore,
					passport: {}
				}))
				clientModule.app.use(clientModule.settings.passport.initialize())
				clientModule.app.use(clientModule.settings.passport.session())

				clientModule.app.use(express.static(this.cfg[moduleName].publicPath)) //serve static files

				//load all route paths
				for (let i in clientModule.moduleData) {
					let component = clientModule.moduleData[i],
						routes = component.getRoutes()
					routes.forEach((routeData, index) => {
						if (routeData.path instanceof Array) {
							routeData.path.forEach((path, pIndex) => {
								clientModule.paths.push(path)
							})
						} else {
							clientModule.paths.push(routeData.path)
						}
					})
				}

				//before every route - set up post params logging, redirects and locals
				clientModule.app.use(clientModule.paths, wrap(function* (req, res, next) {
					let originalUrl = req.originalUrl.split('?')[0]
					console.log(`[${moduleName} client]`, originalUrl, 'POST Params: ', JSON.stringify(req.body || {}))

					if (clientModule.settings.unathorizedRedirectRoute && !req.isAuthenticated() && (clientModule.settings.anonymousAccessRoutes.indexOf(originalUrl) === -1)) {
						res.redirect(302, clientModule.settings.unathorizedRedirectRoute)
						return;
					}

					req.locals = {
						moduleName,
						cfg: CORE.cfg,
						settings: clientModule.settings,
						logger: CORE.logger,
						mailClient: CORE.mailClient,
						generalStore: CORE.generalStore,
						tokenManager: CORE.tokenManager,
						db: CORE.modules.db,
						passport: clientModule.settings.passport,
						error: null,
						errorStatus: 500,
						originalUrl
					}
					next()
				}))

				//mount all routes
				for (let i in clientModule.moduleData) {
					let component = clientModule.moduleData[i],
						routes = component.getRoutes()
					routes.forEach((routeData, index) => {
						clientModule.router[routeData.method](routeData.path, wrap(component[routeData.func]()))
					})
				}
				clientModule.app.use('/', clientModule.router)

				//after every route - return handled errors and set up redirects
				clientModule.app.use('*', function (req, res) {
					if (req.locals.error == null) {
						if (req.isAuthenticated()) {
							res.redirect(302, clientModule.settings.notFoundRedirectRoutes.authenticated)
							return;
						}
						res.redirect(302, clientModule.settings.notFoundRedirectRoutes.default)
						return;
					}
					CORE.logger.error(req.locals.error)
					res.status(req.locals.errorStatus).json({error: req.locals.error.customMessage || 'An internal server error has occurred. Please try again.'})
				})

				clientModule.server = http.createServer(clientModule.app)
				clientModule.server.listen(this.cfg[moduleName].serverPort, () => {
					console.log(`[${moduleName} client] Server started.`)
					console.log(`[${moduleName} client] Port:`, this.cfg[moduleName].serverPort)
					console.log(`[${moduleName} client] Configuration profile:`, this.cfg.name)
				})
			}



			// ------------ LOAD THE APIS' ROUTES ---------- \\
			for (let moduleName in this.modules.apis) {
				// build the initial index.html file
				let apiModule = this.modules.apis[moduleName]

				apiModule.app = express()
				apiModule.router = express.Router()
				apiModule.paths = []


				//set up request logging and request body parsing
				apiModule.app.use(requestLogger(`[${moduleName} API] :method request to :url; result: :status; completed in: :response-time; :date`))
				apiModule.app.use(bodyParser.json())  // for 'application/json' request bodies

				//load all route paths
				for (let i in apiModule.moduleData) {
					let component = apiModule.moduleData[i],
						routes = component.getRoutes()
					routes.forEach((routeData, index) => {
						if (routeData.path instanceof Array) {
							routeData.path.forEach((path, pIndex) => {
								apiModule.paths.push(path)
							})
						} else {
							apiModule.paths.push(routeData.path)
						}
					})
				}

				//before every route - set up post params logging, redirects and locals
				apiModule.app.use(apiModule.paths, wrap(function* (req, res, next) {
					let originalUrl = req.originalUrl.split('?')[0]
					console.log(`[${moduleName} API]`, originalUrl, 'POST Params: ', JSON.stringify(req.body || {}))

					req.locals = {
						moduleName,
						cfg: CORE.cfg,
						settings: apiModule.settings,
						logger: CORE.logger,
						mailClient: CORE.mailClient,
						generalStore: CORE.generalStore,
						tokenManager: CORE.tokenManager,
						db: CORE.modules.db,
						error: null,
						errorStatus: 500,
						originalUrl
					}
					next()
				}))

				//mount all routes
				for (let i in apiModule.moduleData) {
					let component = apiModule.moduleData[i],
						routes = component.getRoutes()
					routes.forEach((routeData, index) => {
						if(apiModule.settings.anonymousAccessRoutes.indexOf(routeData.path) === -1) {
							apiModule.router[routeData.method](routeData.path, this.tokenManager.validate({secret: this.cfg[moduleName].jwt.secret, moduleName}), wrap(component[routeData.func]()))
							return;
						}
						apiModule.router[routeData.method](routeData.path, wrap(component[routeData.func]()))
					})
				}
				apiModule.app.use('/', apiModule.router)

				//after every route - return handled errors and set up redirects
				apiModule.app.use('*', function (err, req, res, next) {
					if (req.locals.error == null) {
						res.status(404).json({error: 'Not found.'})
						return;
					}
					CORE.logger.error(req.locals.error)
					res.status(req.locals.errorStatus).json({error: req.locals.error.customMessage || 'An internal server error has occurred. Please try again.'})
				})

				apiModule.server = http.createServer(apiModule.app)
				apiModule.server.listen(this.cfg[moduleName].serverPort, () => {
					console.log(`[${moduleName} API] Server started.`)
					console.log(`[${moduleName} API] Port:`, this.cfg[moduleName].serverPort)
					console.log(`[${moduleName} API] Configuration profile:`, this.cfg.name)
				})
			}
		} catch (e) {
			this.logger.error(e)
		}
	}
}

module.exports = {
	Core,
	baseDBClass,
	baseClientClass,
	baseApiClass
}