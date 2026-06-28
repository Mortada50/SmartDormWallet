# SmartDormWallet

A comprehensive digital wallet and expense management system designed specifically for dormitory residents. SmartDormWallet streamlines financial transactions, tracks shared expenses, and simplifies the management of dorm-related finances.

---

## 📋 Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Environment Configuration](#environment-configuration)
- [Running the Application](#running-the-application)
- [API Documentation](#api-documentation)
- [Database Setup](#database-setup)
- [Testing](#testing)
- [Development](#development)
- [Deployment](#deployment)
- [Contributing](#contributing)
- [License](#license)
- [Support](#support)

---

## ✨ Features

### User Management
- **Secure Authentication** - JWT-based authentication with bcrypt password hashing
- **Two-Factor Authentication** - OTP-based 2FA for enhanced security
- **User Profiles** - Customizable user profiles with avatar support
- **Role-Based Access Control** - Differentiated permissions for users, admins, and dorm managers

### Wallet & Payments
- **Digital Wallet** - Secure balance management and transaction history
- **Multiple Payment Methods** - Support for various payment integrations
- **QR Code Payments** - Easy payment initiation via QR codes
- **Transaction History** - Comprehensive transaction logs with filtering and search
- **Decimal Precision** - Accurate financial calculations using Big.js

### Expense Management
- **Shared Expenses** - Split bills among dorm residents
- **Expense Tracking** - Categorize and track all expenses
- **Automatic Settlements** - Calculate and manage payment settlements between users
- **Receipt Generation** - PDF-based receipt generation

### Additional Features
- **Rate Limiting** - API protection against abuse
- **File Uploads** - Cloudinary integration for media management
- **Email Notifications** - Email-based alerts for transactions
- **Cron Jobs** - Scheduled tasks for automatic operations (BullMQ)
- **Comprehensive Logging** - Winston-based application logging
- **Input Validation** - Zod schema validation for data integrity

---

## 🛠 Tech Stack

### Backend
- **Runtime**: Node.js (v20.0.0+)
- **Framework**: Express.js
- **Database**: MongoDB Atlas
- **Authentication**: JWT + bcrypt
- **OTP**: otplib
- **Cache & Queue**: Redis + BullMQ
- **File Storage**: Cloudinary
- **Validation**: Zod
- **Logging**: Winston
- **Security**: Helmet, CORS, Rate Limiting

### Frontend
- **Framework**: React 19
- **Bundler**: Vite
- **Styling**: Tailwind CSS + PostCSS
- **HTTP Client**: Axios
- **State Management**: Zustand
- **Data Fetching**: TanStack React Query
- **Animations**: Framer Motion
- **Icons**: Lucide React
- **Notifications**: React Hot Toast
- **Routing**: React Router DOM
- **PWA**: Vite PWA Plugin
- **Date Handling**: date-fns

---

## 🏗 Architecture

SmartDormWallet follows a modern full-stack architecture:

```
SmartDormWallet/
├── backend/                 # Node.js/Express API
│   ├── src/
│   │   ├── server.js       # Entry point
│   │   ├── db/             # Database configuration
│   │   ├── models/         # Mongoose schemas
│   │   ├── routes/         # API routes
│   │   ├── controllers/    # Route handlers
│   │   ├── middleware/     # Custom middleware
│   │   ├── services/       # Business logic
│   │   ���── utils/          # Utilities
│   ├── __tests__/          # Test suite
│   └── package.json
│
├── frontend/               # React SPA
│   ├── src/
│   │   ├── main.jsx       # Entry point
│   │   ├── components/    # React components
│   │   ├── pages/         # Page components
│   │   ├── hooks/         # Custom hooks
│   │   ├── store/         # Zustand state
│   │   ├── services/      # API services
│   │   └── styles/        # CSS & Tailwind
│   ├── public/            # Static assets
│   └── package.json
│
└── README.md
```

---

## 📦 Prerequisites

- **Node.js**: v20.0.0 or higher
- **npm**: v10.0.0 or higher
- **MongoDB**: Atlas cluster (or local MongoDB)
- **Redis**: For caching and job queue
- **Environment Variables**: `.env` file with required credentials

---

## 🚀 Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/Mortada50/SmartDormWallet.git
   cd SmartDormWallet
   ```

2. **Install backend dependencies**
   ```bash
   cd backend
   npm install
   ```

3. **Install frontend dependencies**
   ```bash
   cd ../frontend
   npm install
   ```

---

## 🔧 Environment Configuration

### Backend (.env)
Create a `.env` file in the `backend/` directory:

```env
# Server Configuration
NODE_ENV=development
PORT=5000

# Database
MONGODB_URI=mongodb+srv://<username>:<password>@cluster.mongodb.net/smartdormwallet

# JWT
JWT_SECRET=your_jwt_secret_key
JWT_EXPIRE=7d

# Redis
REDIS_URL=redis://localhost:6379

# Email Service
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_app_password

# Cloudinary
CLOUDINARY_NAME=your_cloudinary_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret

# OTP Configuration
OTP_WINDOW=1
OTP_LIFETIME=300

# Rate Limiting
RATE_LIMIT_WINDOW=15
RATE_LIMIT_MAX_REQUESTS=100
```

### Frontend (.env)
Create a `.env` file in the `frontend/` directory:

```env
VITE_API_URL=http://localhost:5000/api
VITE_APP_NAME=SmartDormWallet
```

---

## 🏃 Running the Application

### Backend
```bash
cd backend

# Development (with auto-reload)
npm run dev

# Production
npm start

# Create database collections
npm run db:create-collections

# Seed sample data
npm run db:seed
```

### Frontend
```bash
cd frontend

# Development server (hot reload)
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

Access the application at `http://localhost:5173`

---

## 📚 API Documentation

The backend provides RESTful API endpoints for:

- **Authentication**: `/api/auth/` - login, register, verify OTP
- **Users**: `/api/users/` - profile management
- **Wallet**: `/api/wallet/` - balance, transactions
- **Expenses**: `/api/expenses/` - create, read, settle shared expenses
- **Settlements**: `/api/settlements/` - calculate and manage payables

For detailed API documentation, refer to the inline JSDoc comments in `backend/src/routes/`.

---

## 💾 Database Setup

### Create Collections
```bash
cd backend
npm run db:create-collections
```

### Seed Sample Data
```bash
npm run db:seed
```

This creates sample users, dorms, and transactions for development/testing.

---

## 🧪 Testing

### Run Tests
```bash
cd backend

# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Generate coverage report
npm run test:coverage
```

Tests are located in `backend/__tests__/` and follow Jest conventions.

---

## 👨‍💻 Development

### Code Style
```bash
# Lint code
npm run lint

# Fix linting issues
npm run lint:fix
```

### Hot Reload
- **Backend**: Uses `nodemon` for automatic restart on file changes
- **Frontend**: Vite provides instant HMR (Hot Module Replacement)

### Project Structure Best Practices
- Keep routes thin; move logic to controllers/services
- Use middleware for cross-cutting concerns
- Organize components by feature in the frontend
- Follow naming conventions (camelCase for files, PascalCase for components)

---

## 🚢 Deployment

### Backend Deployment
1. Set `NODE_ENV=production` in `.env`
2. Ensure all environment variables are configured
3. Run tests: `npm test`
4. Deploy to hosting platform (Heroku, AWS, Railway, etc.)

### Frontend Deployment
1. Build the application: `npm run build`
2. The `dist/` folder contains production-ready files
3. Deploy to static hosting (Vercel, Netlify, AWS S3, etc.)

### Database & Infrastructure
- MongoDB Atlas handles database hosting and scalability
- Redis should be configured for production environments
- Cloudinary handles image and file storage

---

## 🤝 Contributing

1. **Fork the repository**
2. **Create a feature branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. **Make your changes and commit**
   ```bash
   git commit -m "Add: description of your changes"
   ```
4. **Push to your fork**
   ```bash
   git push origin feature/your-feature-name
   ```
5. **Submit a Pull Request** with a clear description

### Code Standards
- Follow ESLint configuration
- Write tests for new features
- Update documentation as needed
- Use conventional commit messages

---

## 📄 License

This project is licensed under the MIT License. See the LICENSE file for details.

---

## 💬 Support

For issues, questions, or suggestions:

- **GitHub Issues**: [Open an issue](https://github.com/Mortada50/SmartDormWallet/issues)
- **Email**: Contact the project maintainer
- **Documentation**: Check inline code comments and API documentation

---

## 🙏 Acknowledgments

Built with ❤️ for dormitory communities to simplify financial management and foster transparency in shared expenses.

---

**Happy coding! 🚀**