(function (global) {
  'use strict';

  function normalizeEmailConfirmation(saveResult) {
    if (!saveResult || !saveResult.emailConfirmation) {
      return { sent: false, reason: 'UNAVAILABLE' };
    }

    return saveResult.emailConfirmation;
  }

  function buildDefaultFeedback(reserva, emailConfirmation) {
    if (emailConfirmation.sent) {
      return {
        type: 'success',
        message: 'Reserva registrada com sucesso! Confirmacao enviada para ' + reserva.email + '.'
      };
    }

    return {
      type: 'error',
      message: 'Falha no envio do e-mail de confirmacao. Tente novamente em instantes.'
    };
  }

  async function run(options) {
    var context = options || {};
    var reserva = context.reserva || {};
    var saveResult = context.saveResult || {};
    var actions = Array.isArray(context.actions) ? context.actions : [];
    var emailConfirmation = normalizeEmailConfirmation(saveResult);
    var feedback = buildDefaultFeedback(reserva, emailConfirmation);

    for (var i = 0; i < actions.length; i += 1) {
      var action = actions[i];
      if (typeof action !== 'function') {
        continue;
      }

      try {
        var actionResult = await action({
          reserva: reserva,
          saveResult: saveResult,
          emailConfirmation: emailConfirmation,
          feedback: feedback
        });

        if (actionResult && typeof actionResult === 'object') {
          if (typeof actionResult.type === 'string' && actionResult.type) {
            feedback.type = actionResult.type;
          }
          if (typeof actionResult.message === 'string' && actionResult.message) {
            feedback.message = actionResult.message;
          }
        }
      } catch (error) {
        console.error('Erro em acao pos-reserva:', error);
      }
    }

    return {
      feedbackType: feedback.type,
      feedbackMessage: feedback.message,
      emailConfirmation: emailConfirmation
    };
  }

  global.ReservationSubmitActions = {
    run: run
  };
})(window);
