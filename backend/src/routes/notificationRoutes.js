'use strict';

const router = require('express').Router();
const { authenticate, requireUser } = require('../middleware/authMiddleware');
const notificationRepository = require('../repositories/notificationRepository');
const { asyncHandler } = require('../middleware/errorMiddleware');
const { z } = require('zod');

// GET /api/v1/notifications
const getMyNotifications = asyncHandler(async (req, res) => {
  const { cursor, limit, unreadOnly } = req.query;
  const userRepo = require('../repositories/userRepository');
  const actor = await userRepo.findByPublicId(req.user.publicId, null);
  if (!actor) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });

  const result = await notificationRepository.findPaginatedForUser(actor._id, {
    cursor,
    limit: limit ? parseInt(limit, 10) : 20,
    unreadOnly: unreadOnly === 'true'
  });

  return res.status(200).json({ success: true, data: result });
});

// PATCH /api/v1/notifications/read
const markAsRead = asyncHandler(async (req, res) => {
  const userRepo = require('../repositories/userRepository');
  const actor = await userRepo.findByPublicId(req.user.publicId, null);
  if (!actor) return res.status(404).json({ success: false, message: 'المستخدم غير موجود' });
  const { publicId } = req.body;

  if (publicId) {
    await notificationRepository.markOneRead(publicId, actor._id);
  } else {
    await notificationRepository.markAllRead(actor._id);
  }

  return res.status(200).json({ success: true, message: 'Notifications marked as read' });
});

router.use(authenticate, requireUser);
router.get('/', getMyNotifications);
router.patch('/read', markAsRead);

module.exports = router;
