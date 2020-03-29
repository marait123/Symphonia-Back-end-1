const crypto = require('crypto');
const { promisify } = require('util');
const _ = require('lodash');
const passport = require('passport');
const jwt = require('jsonwebtoken');
const { User, validate } = require('../models/userModel');
const catchAsync = require('../utils/catchAsync').threeArg;
const AppError = require('../utils/appError');
const Email = require('../utils/email');

const createSendToken = (user, statusCode, res) => {
  const token = user.signToken();
  // Remove password and tracks from output
  user.password = undefined;
  user.tracks = undefined;
  user.__v = undefined;
  user.followedUsers = undefined;
  res.status(statusCode).json({
    status: 'success',
    data: {
      token,
      user
    }
  });
};
exports.signup = catchAsync(async (req, res, next) => {
  // validate with JOI as a first layer of validation
  await validate(req.body);
  // insert the user data in the database
  const newUser = await User.create({
    ..._.pick(req.body, [
      'email',
      'password',
      'name',
      'emailConfirm',
      'dateOfBirth',
      'gender',
      'type'
    ]),
    passwordConfirm: req.body.password
  });
  const url = `${req.protocol}://${req.get('host')}`;
  await new Email(newUser, url).sendWelcome();

  createSendToken(newUser, 201, res);
});
exports.login = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;
  // Check if email and password exist
  if (!email || !password) {
    return next(new AppError('Please provide email and password!', 400));
  }
  // Check if user exists && password is correct
  const user = await User.findOne({ email }).select('+password');

  if (!user || !(await user.correctPassword(password, user.password))) {
    return next(new AppError('Incorrect email or password', 401));
  }
  // If everything ok, send token to client
  user.last_login = Date.now();
  await user.save({ validateBeforeSave: false });
  createSendToken(user, 200, res);
});
exports.googleOauth = catchAsync(async (req, res, next) => {
  if (req.user.status === 201) {
    const url = `${req.protocol}://${req.get('host')}`;
    await new Email(req.user, url).sendWelcome();
  }
  req.user.facebookId = undefined;
  req.user.imageFacebookUrl = undefined;
  createSendToken(req.user, req.user.status, res);
});
exports.facebookOauth = catchAsync(async (req, res, next) => {
  if (req.user.status === 201) {
    const url = `${req.protocol}://${req.get('host')}`;
    await new Email(req.user, url).sendWelcome();
  }
  req.user.googleId = undefined;
  req.user.imageGoogleUrl = undefined;
  createSendToken(req.user, req.user.status, res);
});
// this will be handeled by making the website protocol https://localhost:3000 not http://localhost:3000
exports.googleUnlink = catchAsync(async (req, res, next) => {});
exports.facebookUnlink = catchAsync(async (req, res, next) => {});

exports.protect = catchAsync(async (req, res, next) => {
  // 1) Getting token and check of it's there
  let token;
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return next(
      new AppError('You are not logged in! Please log in to get access.', 401)
    );
  }
  // 2) Verification token
  const decoded = await promisify(jwt.verify)(
    token,
    process.env.JWT_SECRET_KEY
  );
  // 3) Check if user still exists
  const currentUser = await User.findById(decoded.id);
  if (!currentUser) {
    return next(
      new AppError(
        'The user belonging to this token does no longer exist.',
        401
      )
    );
  }
  // 4) Check if user changed password after the token was issued
  if (currentUser.changedPasswordAfter(decoded.iat)) {
    return next(
      new AppError('User recently changed password! Please log in again.', 401)
    );
  }
  // GRANT ACCESS TO PROTECTED ROUTE
  req.user = currentUser;
  next();
});
exports.restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return next(
        new AppError('You do not have permission to perform this action', 403)
      );
    }
    next();
  };
};

exports.forgotPassword = catchAsync(async (req, res, next) => {
  // 1) Get user based on POSTed email
  const user = await User.findOne({
    email: req.body.email
  });
  if (!user) {
    return next(new AppError('There is no user with email address.', 404));
  }
  // 2) Generate the random reset token
  const resetToken = user.createPasswordResetToken();
  await user.save({
    validateBeforeSave: false
  });
  // 3) Send it to user's email
  try {
    const resetURL = `${req.protocol}://${req.get(
      'host'
    )}password-reset/change/${resetToken}`;
    await new Email(user, resetURL).sendPasswordReset();

    res.status(200).json({
      status: 'success',
      message: 'Token sent to email!'
    });
  } catch (err) {
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save({
      validateBeforeSave: false
    });
    return next(
      new AppError('There was an error sending the email. Try again later!'),
      500
    );
  }
});

exports.resetPassword = catchAsync(async (req, res, next) => {
  // 1) Get user based on the token
  const hashedToken = crypto
    .createHash('sha256')
    .update(req.params.token)
    .digest('hex');
  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: {
      $gt: Date.now()
    }
  });
  // 2) If token has not expired, and there is user, set the new password
  if (!user) {
    return next(new AppError('Token is invalid or has expired', 400));
  }
  user.emailConfirm = user.email;
  user.password = req.body.password;
  user.passwordConfirm = req.body.passwordConfirm;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await user.save();
  // 3) Update changedPasswordAt property for the user
  // 4) Log the user in, send JWT
  createSendToken(user, 200, res);
});
exports.updatePassword = catchAsync(async (req, res, next) => {
  // 1) Get user from collection
  const user = await User.findById(req.user.id).select('+password');
  // 2) Check if POSTed current password is correct
  if (!(await user.correctPassword(req.body.passwordCurrent, user.password))) {
    return next(new AppError('Your current password is wrong.', 401));
  }
  // 3) If so, update password
  user.emailConfirm = user.email;
  user.password = req.body.password;
  user.passwordConfirm = req.body.passwordConfirm;
  await user.save();
  // User.findByIdAndUpdate will NOT work as intended!
  // 4) Log user in, send JWT
  createSendToken(user, 200, res);
});